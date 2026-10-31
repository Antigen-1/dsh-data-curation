// 0.6.1: migration hand-off (seal/pin_id/migration_pending/records drift),
// legacy provenance repair, and dryRun-hash == signed-hash.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { doPin } from '../lib/core.js'
import { createStore } from '../lib/store.js'

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

/** A v3 workspace with a curated table that drifted (CASE-3 exists, not in the contract). */
function makeV3Workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'curation-mig061-'))
  const path = join(dir, 'project.sqlite')
  const db = new DatabaseSync(path)
  db.exec(V3_DDL)
  db.exec(`CREATE TABLE summary (record_id TEXT PRIMARY KEY, location TEXT, note TEXT)`)
  db.exec(`INSERT INTO summary (record_id, location) VALUES ('CASE-1','A区'), ('CASE-2','B区'), ('CASE-3','C区')`)
  db.prepare("INSERT INTO meta (key, value) VALUES ('contract_hash', 'legacy-contract-hash'), ('contract_signed_at', '2026-01-01T00:00:00Z')").run()
  db.prepare('INSERT INTO contract (id, version, hash, json, signed_at) VALUES (1, 3, ?, ?, ?)')
    .run('legacy-contract-hash', JSON.stringify(v3Contract()), '2026-01-01T00:00:00Z')
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

const pinOf = (records = ['CASE-1', 'CASE-2']) => ({
  version: 5,
  project: { name: 'demo' },
  defaults: {
    channels: [{ name: 'text' }, { name: 'vision' }],
    normalization: { mode: 'safe' },
    evidence: { required: true },
    gates: { minAcceptedRatio: 0.5 },
  },
  tables: [{
    table: 'summary',
    key: 'record_id',
    records: { kind: 'list', values: records },
    fields: [{ name: 'location', allowEmpty: false }, { name: 'note', allowEmpty: true }],
  }],
})

test('v3 迁移后工作区自解释：封印/meta.pin_id/迁移中间态/记录漂移/旧 meta 键改名', async () => {
  const { dir } = makeV3Workspace()
  const store = createStore(dir, '.')
  await store.withDb(() => {})

  assert.ok(existsSync(store.sealPath), '迁移必须写 pin.sha256')
  assert.ok(existsSync(store.pinMirrorPath), '迁移必须写 pin.json')
  const report = JSON.parse(readFileSync(store.migrationReportPath, 'utf8'))
  assert.equal(report.fromSchema, 3)
  assert.equal(report.toSchema, 4)
  assert.deepEqual(report.records.drift.added, ['CASE-3'])
  assert.equal(report.records.drift.removedCount, 0)

  const db = new DatabaseSync(store.dbPath, { readOnly: true })
  try {
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]))
    assert.ok(meta.pin_id, 'meta.pin_id 必须写入')
    assert.equal(meta.migration_pending, '1')
    assert.equal(meta.pin_hash, report.pin.hash)
    assert.equal(readFileSync(store.sealPath, 'utf8').trim(), report.pin.hash)
    assert.ok(!('contract_hash' in meta), '旧 contract_hash 必须改名')
    assert.equal(meta.legacy_contract_hash, 'legacy-contract-hash')
    assert.equal(meta.legacy_contract_signed_at, '2026-01-01T00:00:00Z')

    const decision = db.prepare('SELECT id, pin_id, table_pin_id FROM decision').get()
    assert.equal(decision.pin_id, report.pin.id)
    assert.equal(decision.table_pin_id, db.prepare('SELECT id FROM table_pin').get().id)
    const ledger = db.prepare('SELECT decision_id, apply_run_id FROM ledger').get()
    assert.equal(ledger.decision_id, decision.id)
    assert.equal(ledger.apply_run_id, 'apply-1')
    assert.equal(db.prepare('SELECT pin_id FROM run_table').get().pin_id, report.pin.id)
    assert.ok(existsSync(store.schemaPath), '必须导出 schema.sql')
    assert.match(readFileSync(store.schemaPath, 'utf8'), /user_version=4/)
  } finally {
    db.close()
  }
})

test('dryRun 的 hash 与正式签署后的封印一致；force 无 reason 被拒绝', async () => {
  const { dir } = makeV3Workspace()
  const store = createStore(dir, '.')
  await store.withDb(() => {})
  await store.writeManifest({ entries: [], sha256: 'empty', createdAt: new Date().toISOString(), sources: [] })

  const pin = pinOf()
  const dry = await doPin({ cwd: dir, stateDir: '.', pin, dryRun: true })
  assert.equal(dry.ok, true, dry.error)
  assert.equal(dry.hashKind, 'aggregate')

  const refused = await doPin({ cwd: dir, stateDir: '.', pin, force: true })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /force 重签必须提供 reason/)

  const signed = await doPin({ cwd: dir, stateDir: '.', pin, force: true, reason: '测试：迁移后重签' })
  assert.equal(signed.ok, true, signed.error)
  assert.equal(signed.hash, dry.hash, 'dryRun hash 必须等于签署封印')
  assert.equal(readFileSync(store.sealPath, 'utf8').trim(), signed.hash)

  await store.withDb(async () => {})
  const db = new DatabaseSync(store.dbPath, { readOnly: true })
  try {
    const pending = db.prepare("SELECT value FROM meta WHERE key = 'migration_pending'").get()
    assert.equal(pending, undefined, '重签后必须清除迁移中间态')
    const events = db.prepare("SELECT text FROM project_event WHERE kind = 'auto' ORDER BY at DESC").all().map((r) => r.text)
    assert.ok(events.some((t) => t.includes('测试：迁移后重签')), '重签原因必须进项目事件')
  } finally {
    db.close()
  }
})

test('0.6.0 已迁移的工作区：打开时一次性回填 provenance 并写修复报告', async () => {
  const { dir } = makeV3Workspace()
  const store = createStore(dir, '.')
  await store.withDb(() => {})

  // Simulate a workspace migrated by 0.6.0: provenance still NULL, no repair marker.
  const db = new DatabaseSync(store.dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('UPDATE decision SET pin_id = NULL, table_pin_id = NULL')
  db.exec('UPDATE ledger SET decision_id = NULL, apply_run_id = NULL')
  db.exec('UPDATE run_table SET pin_id = NULL')
  db.exec("DELETE FROM meta WHERE key = 'provenance_repaired'")
  db.exec("DELETE FROM project_event WHERE actor = 'repair'")
  db.exec("INSERT INTO meta (key, value) VALUES ('contract_hash', 'legacy-contract-hash') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  db.close()

  await store.withDb(() => {})

  assert.ok(existsSync(store.repairReportPath), '必须写 provenance-repair.json')
  const report = JSON.parse(readFileSync(store.repairReportPath, 'utf8'))
  assert.equal(report.decisions, 1)
  assert.equal(report.ledgerDecision, 1)
  assert.equal(report.ledgerApply, 1)
  assert.equal(report.runTable, 1)
  assert.equal(report.metaKeys, 1)

  const check = new DatabaseSync(store.dbPath, { readOnly: true })
  try {
    assert.ok(check.prepare('SELECT pin_id FROM decision').get().pin_id)
    assert.ok(check.prepare('SELECT table_pin_id FROM decision').get().table_pin_id)
    assert.equal(check.prepare('SELECT decision_id FROM ledger').get().decision_id, 1)
    assert.equal(check.prepare('SELECT apply_run_id FROM ledger').get().apply_run_id, 'apply-1')
    assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'provenance_repaired'").get().value, '1')
    assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'legacy_contract_hash'").get().value, 'legacy-contract-hash')
  } finally {
    check.close()
  }

  // Second open must not re-run the repair.
  await store.withDb(() => {})
  const again = JSON.parse(readFileSync(store.repairReportPath, 'utf8'))
  assert.deepEqual(again, report)
})
