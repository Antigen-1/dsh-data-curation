// lib/db.js — SQLite plumbing on the built-in node:sqlite module.
//
// The plugin deliberately uses Node's built-in SQLite (no native dependency):
// transactions give us atomic cell writes, and SQL gives verification queries
// that stay honest at 20k+ cells. node:sqlite is flag-free from Node 23.4, so
// package.json requires Node >= 24.
import { DatabaseSync } from 'node:sqlite'

export const STATE_SCHEMA_VERSION = 2

/** Workspace tables owned by the plugin; a contract may not name them. */
export const STATE_TABLES = [
  'meta', 'submission', 'submission_value', 'decision', 'ledger', 'run', 'applied',
  'contract', 'exporter',
]

export const RESERVED_TABLES = new Set([
  ...STATE_TABLES, 'sqlite_master', 'sqlite_schema', 'sqlite_sequence', 'sqlite_temp_master',
])

/**
 * Open (or create) a database. Read-only handles cannot write, by design.
 *
 * `timeout` is SQLite's busy timeout, measured in milliseconds; Node's default
 * is 0, which turns any writer collision into an instant `database is locked`.
 */
export function openDb(path, { readOnly = false, timeout = 5000 } = {}) {
  const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true, timeout })
  try { db.exec(`PRAGMA busy_timeout = ${Number(timeout) || 0}`) } catch { /* readonly handles may refuse */ }
  return db
}

/** Run fn inside BEGIN IMMEDIATE … COMMIT; roll back on any throw. */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* transaction may already be gone */ }
    throw e
  }
}

/** Escape an identifier (table/column) for interpolation. */
export function quoteIdent(name) {
  if (typeof name !== 'string' || !name) throw new Error('标识符不能为空')
  return `"${name.replace(/"/g, '""')}"`
}

/** Column names of an existing table, in order. */
export function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name)
}

export function tableExists(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  return Boolean(row)
}

/**
 * Consistent snapshot of a database into `target` (SQLite VACUUM INTO).
 * The file must not exist yet, which is what timestamped backup names give us.
 */
export function backupDb(db, target) {
  db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`)
  return target
}

/**
 * Create the state schema, or refuse a workspace written by another version.
 *
 * `PRAGMA user_version` is the only migration marker: a workspace created by an
 * older release refuses to open (its tables may lack columns the new code
 * expects) instead of failing later with an opaque `no such column`.
 */
export function ensureStateSchema(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const current = Number(row?.user_version ?? 0)
  if (current > STATE_SCHEMA_VERSION) {
    throw new Error(`工作区由更新版本的 dsh-data-curation 创建（v${current} > v${STATE_SCHEMA_VERSION}），请升级插件后重试`)
  }
  if (current !== 0 && current < STATE_SCHEMA_VERSION) {
    throw new Error(`工作区由旧版本创建（v${current} < v${STATE_SCHEMA_VERSION}）：目前不自动迁移，请备份后删除 .curation/ 并重新 curation_init（见 docs/DATABASE.md）`)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contract (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      json TEXT NOT NULL,
      signed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exporter (
      name TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      args TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submission (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      batch TEXT NOT NULL,
      record TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('valid', 'uncertain', 'invalid')),
      submitted_at TEXT NOT NULL,
      notes TEXT,
      UNIQUE (channel, batch, record)
    );

    CREATE TABLE IF NOT EXISTS submission_value (
      submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      evidence TEXT,
      PRIMARY KEY (submission_id, field)
    );

    CREATE TABLE IF NOT EXISTS decision (
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
    CREATE INDEX IF NOT EXISTS decision_cell ON decision (record, field, id);

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applied_at TEXT NOT NULL,
      record TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      adopted TEXT,
      dissent TEXT,
      evidence TEXT,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS ledger_cell ON ledger (record, field, id);

    CREATE TABLE IF NOT EXISTS run (
      run_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS applied (
      run_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      ops INTEGER NOT NULL,
      backup TEXT,
      delivery_table TEXT
    );
  `)
  db.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}`)
  return db
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value))
}

export const toJson = (value) => (value === undefined ? null : JSON.stringify(value))

export function fromJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback
  try { return JSON.parse(text) } catch { return fallback }
}
