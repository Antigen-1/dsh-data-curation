// Schema-version gates + the v3→v4 workspace migration.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { STATE_SCHEMA_VERSION, ensureStateSchema, openDb } from '../lib/db.js'

const freshLegacy = (version, sql = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'curation-migrate-'))
  const path = join(dir, 'project.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); ${sql} PRAGMA user_version = ${version};`)
  legacy.close()
  return path
}

test('v1 工作区拒绝打开并提示重建', () => {
  const db = openDb(freshLegacy(1))
  try {
    assert.throws(() => ensureStateSchema(db), /旧版本创建/)
  } finally {
    db.close()
  }
})

test('v2/v3 工作区迁移前必须先声明备份路径', () => {
  const db = openDb(freshLegacy(2, 'CREATE TABLE decision (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, record TEXT, field TEXT);'))
  try {
    assert.throws(() => ensureStateSchema(db), /迁移前必须先创建备份/)
  } finally {
    db.close()
  }
})

test('更新版本的工作区拒绝打开并提示升级插件', () => {
  const db = openDb(freshLegacy(STATE_SCHEMA_VERSION + 1))
  try {
    assert.throws(() => ensureStateSchema(db), /请升级插件后重试/)
  } finally {
    db.close()
  }
})

// The exact v3 workspace shape emitted by 0.5.0 (schema version 3).
const V3_DDL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE contract (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
    hash TEXT NOT NULL, json TEXT NOT NULL, signed_at TEXT NOT NULL);
  CREATE TABLE exporter (name TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT, created_at TEXT NOT NULL);
  CREATE TABLE submission (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, batch TEXT NOT NULL,
    record TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('valid','uncertain','invalid')),
    submitted_at TEXT NOT NULL, notes TEXT, UNIQUE (channel, batch, record));
  CREATE TABLE submission_value (submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
    field TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT, PRIMARY KEY (submission_id, field));
  CREATE TABLE decision (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, record TEXT NOT NULL,
    field TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted','pending')), value TEXT,
    normalized TEXT, adopted TEXT, dissent TEXT, votes TEXT, reason TEXT, evidence TEXT,
    synthesized INTEGER NOT NULL DEFAULT 0, decided_at TEXT NOT NULL);
  CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, applied_at TEXT NOT NULL, record TEXT NOT NULL,
    field TEXT NOT NULL, old_value TEXT, new_value TEXT, adopted TEXT, dissent TEXT, evidence TEXT, run_id TEXT);
  CREATE TABLE run (run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL, summary TEXT NOT NULL);
  CREATE TABLE applied (run_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, ops INTEGER NOT NULL,
    backup TEXT, delivery_table TEXT);
`

const v3Contract = () => ({
  version: 3,
  fields: [{ name: 'location', allowEmpty: false }, { name: 'note', allowEmpty: true }],
  records: { kind: 'list', values: ['CASE-1', 'CASE-2'] },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  normalization: { mode: 'safe' },
  evidence: { required: true },
  gates: { minAcceptedRatio: 0.5 },
})

function makeV3Workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'curation-v3-'))
  const path = join(dir, 'project.sqlite')
  const db = new DatabaseSync(path)
  db.exec(V3_DDL)
  db.prepare('INSERT INTO contract (id, version, hash, json, signed_at) VALUES (1, 3, ?, ?, ?)')
    .run('legacy-hash', JSON.stringify(v3Contract()), '2026-01-01T00:00:00Z')
  db.prepare("INSERT INTO submission (channel, batch, record, status, submitted_at) VALUES ('text','B1','CASE-1','valid','2026-01-01T00:00:00Z')").run()
  db.prepare("INSERT INTO submission_value (submission_id, field, value) VALUES (1, 'location', 'A区')").run()
  db.prepare(`INSERT INTO decision (run_id, record, field, status, value, decided_at)
    VALUES ('run-1','CASE-1','location','accepted','A区','2026-01-01T00:00:00Z')`).run()
  db.prepare(`INSERT INTO ledger (applied_at, record, field, new_value, run_id)
    VALUES ('2026-01-01T00:00:00Z','CASE-1','location','A区','run-1')`).run()
  db.prepare("INSERT INTO run (run_id, kind, created_at, summary) VALUES ('run-1','compare','2026-01-01T00:00:00Z','{}')").run()
  db.prepare("INSERT INTO applied (run_id, applied_at, ops, delivery_table) VALUES ('apply-1','2026-01-01T00:00:00Z',1,'summary')").run()
  db.exec('PRAGMA user_version = 3')
  db.close()
  return { dir, path }
}

test('v3 工作区迁移到 v4：先备份，再补 table 维度并把旧契约转成 revision 1 的 table_pin', () => {
  const { dir, path } = makeV3Workspace()
  const backup = join(dir, 'backup-pre-v4.sqlite')
  const db = openDb(path)
  try {
    ensureStateSchema(db, { backupPath: backup })
    assert.ok(existsSync(backup), '迁移前必须留下备份')
    const old = new DatabaseSync(backup, { readOnly: true })
    assert.equal(Number(old.prepare('PRAGMA user_version').get().user_version), 3)
    old.close()

    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 4)
    const subCols = db.prepare("SELECT name FROM pragma_table_info('submission')").all().map((r) => r.name)
    assert.ok(subCols.includes('table_id'))
    assert.equal(db.prepare('SELECT table_id FROM submission').get().table_id, 'summary')
    assert.equal(db.prepare('SELECT table_id FROM decision').get().table_id, 'summary')
    assert.equal(db.prepare('SELECT table_id FROM ledger').get().table_id, 'summary')
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM run_table').get().c, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM applied_table').get().c, 1)

    const pin = db.prepare('SELECT id, hash, json FROM pin').get()
    assert.ok(pin, '迁移必须生成聚合 pin')
    const snapshot = JSON.parse(pin.json)
    assert.equal(snapshot.version, 5)
    assert.equal(snapshot.tables[0].table, 'summary')
    assert.equal(snapshot.tables[0].fields.length, 2)

    const tablePin = db.prepare('SELECT revision, legacy_contract_hash, json FROM table_pin').get()
    assert.equal(tablePin.revision, 1)
    assert.equal(tablePin.legacy_contract_hash, 'legacy-hash')
    assert.equal(JSON.parse(tablePin.json).table, 'summary')
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='pin_hash'").get().value, pin.hash)
  } finally {
    db.close()
  }

  const reopened = openDb(path)
  try {
    ensureStateSchema(reopened) // already v4: idempotent, no backup needed
    assert.equal(reopened.prepare('SELECT COUNT(*) AS c FROM decision').get().c, 1)
  } finally {
    reopened.close()
  }
})
