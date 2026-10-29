// A workspace written by 0.3.x must open in 0.4.0: the only schema change is
// decision.synthesized, and old rows were decided before synthesis existed.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { STATE_SCHEMA_VERSION, ensureStateSchema, openDb, tableColumns } from '../lib/db.js'

test('v2 工作区自动迁移到 v3：补 synthesized 列并保留旧行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curation-migrate-'))
  const path = join(dir, 'project.sqlite')

  // 手工造一个 v2 形态的库：decision 表没有 synthesized 列
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      record TEXT NOT NULL,
      field TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'pending')),
      value TEXT,
      normalized TEXT,
      adopted TEXT,
      dissent TEXT,
      votes TEXT,
      reason TEXT,
      evidence TEXT,
      decided_at TEXT NOT NULL
    );
    INSERT INTO decision (run_id, record, field, status, value, decided_at)
    VALUES ('run-1', 'CASE-1', 'location', 'accepted', 'A区', '2026-01-01T00:00:00Z');
    PRAGMA user_version = 2;
  `)
  legacy.close()

  const db = openDb(path)
  try {
    ensureStateSchema(db)
    const columns = tableColumns(db, 'decision')
    assert.ok(columns.includes('synthesized'), `columns: ${columns.join(',')}`)
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), STATE_SCHEMA_VERSION)
    const row = db.prepare('SELECT value, synthesized FROM decision').get()
    assert.equal(row.value, 'A区')
    assert.equal(Number(row.synthesized), 0)
  } finally {
    db.close()
  }
})

test('v1 工作区仍然拒绝打开（没有可用的自动迁移）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curation-migrate-old-'))
  const path = join(dir, 'project.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;')
  legacy.close()

  const db = openDb(path)
  try {
    assert.throws(() => ensureStateSchema(db), /旧版本创建/)
  } finally {
    db.close()
  }
})
