// lib/db.js — SQLite plumbing on the built-in node:sqlite module.
//
// The plugin deliberately uses Node's built-in SQLite (no native dependency):
// transactions give us atomic cell writes, and SQL gives verification queries
// that stay honest at 20k+ cells. node:sqlite is flag-free from Node 23.4, so
// package.json requires Node >= 24.
import { DatabaseSync } from 'node:sqlite'
import { sha256 } from './util.js'

// v4 = 0.6.0 meta layers: project/table_registry/pin/table_pin and a table_id
// on every piece of run state. v3 workspaces migrate (with a pre-migration
// snapshot) the first time they are opened by this release.
export const STATE_SCHEMA_VERSION = 4

/** Workspace tables owned by the plugin; a pin may not name them. */
export const STATE_TABLES = [
  'meta', 'submission', 'submission_value', 'decision', 'ledger', 'run', 'run_table',
  'applied', 'applied_table', 'project', 'table_registry', 'project_event', 'pin',
  'table_pin', 'table_event', 'contract', 'exporter',
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

const SCHEMA_V4 = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS table_registry (
    table_id TEXT PRIMARY KEY,
    delivery_table TEXT NOT NULL UNIQUE,
    purpose TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('auto', 'note')),
    actor TEXT,
    text TEXT NOT NULL,
    pin_id TEXT
  );

  CREATE TABLE IF NOT EXISTS pin (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    json TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    pinned_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS table_pin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate_pin_id TEXT NOT NULL REFERENCES pin(id),
    table_id TEXT NOT NULL REFERENCES table_registry(table_id),
    revision INTEGER NOT NULL,
    hash TEXT NOT NULL,
    json TEXT NOT NULL,
    legacy_contract_hash TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (aggregate_pin_id, table_id),
    UNIQUE (table_id, revision)
  );

  CREATE TABLE IF NOT EXISTS table_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id TEXT NOT NULL REFERENCES table_registry(table_id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('auto', 'note')),
    text TEXT NOT NULL,
    pin_id TEXT,
    actor TEXT
  );

  CREATE TABLE IF NOT EXISTS exporter (
    name TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    args TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submission (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id TEXT NOT NULL REFERENCES table_registry(table_id),
    channel TEXT NOT NULL,
    batch TEXT NOT NULL,
    record TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('valid', 'uncertain', 'invalid')),
    submitted_at TEXT NOT NULL,
    notes TEXT,
    UNIQUE (table_id, channel, batch, record)
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
    table_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    pin_id TEXT,
    table_pin_id INTEGER,
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
    synthesized INTEGER NOT NULL DEFAULT 0,
    decided_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decision_cell ON decision (table_id, record, field, id);

  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    record TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    adopted TEXT,
    dissent TEXT,
    evidence TEXT,
    run_id TEXT,
    decision_id INTEGER,
    apply_run_id TEXT
  );
  CREATE INDEX IF NOT EXISTS ledger_cell ON ledger (table_id, record, field, id);

  CREATE TABLE IF NOT EXISTS run (
    run_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_table (
    run_id TEXT NOT NULL,
    table_id TEXT NOT NULL,
    pin_id TEXT,
    summary TEXT NOT NULL,
    PRIMARY KEY (run_id, table_id)
  );

  CREATE TABLE IF NOT EXISTS applied (
    run_id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    ops INTEGER NOT NULL,
    backup TEXT,
    delivery_table TEXT
  );

  CREATE TABLE IF NOT EXISTS applied_table (
    run_id TEXT NOT NULL,
    table_id TEXT NOT NULL,
    ops INTEGER NOT NULL,
    delivery_table TEXT,
    PRIMARY KEY (run_id, table_id)
  );

  CREATE INDEX IF NOT EXISTS submission_table ON submission (table_id, channel, record);

  CREATE VIEW IF NOT EXISTS table_field AS
    SELECT tp.table_id AS table_id,
           json_extract(f.value, '$.name') AS name,
           json_extract(f.value, '$.type') AS type
    FROM table_pin tp
    JOIN (SELECT table_id, MAX(revision) AS revision FROM table_pin GROUP BY table_id) latest
      ON latest.table_id = tp.table_id AND latest.revision = tp.revision
    JOIN json_each(tp.json, '$.fields') f;
`


// Minimal tables the v3→v4 rebuild needs before the new columns exist.
const SCHEMA_V4_BASE = `
  CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS table_registry (
    table_id TEXT PRIMARY KEY,
    delivery_table TEXT NOT NULL UNIQUE,
    purpose TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`

/**
 * Create the state schema, or migrate a v3 workspace.
 *
 * `backupPath` is mandatory when migrating v3: the snapshot is taken before
 * any schema or data write, so an interrupted migration never loses the
 * pre-migration state. Callers that cannot write a backup must not migrate.
 */
export function ensureStateSchema(db, { backupPath = null } = {}) {
  const row = db.prepare('PRAGMA user_version').get()
  let current = Number(row?.user_version ?? 0)
  if (current > STATE_SCHEMA_VERSION) {
    throw new Error(`工作区由更新版本的 dsh-data-curation 创建（v${current} > v${STATE_SCHEMA_VERSION}），请升级插件后重试`)
  }
  if (current === 2) {
    const columns = db.prepare("SELECT name FROM pragma_table_info('decision')").all().map((r) => r.name)
    if (!columns.includes('synthesized')) db.exec('ALTER TABLE decision ADD COLUMN synthesized INTEGER NOT NULL DEFAULT 0')
    db.exec('PRAGMA user_version = 3')
    current = 3
  }
  if (current === 3) {
    if (!backupPath) {
      throw new Error('工作区需要从 v3 迁移到 v4：迁移前必须先创建备份（通过 curation_init/任何写操作打开工作区会自动完成）')
    }
    db.exec('PRAGMA journal_mode = WAL')
    backupDb(db, backupPath)
    migrateV3toV4(db)
    current = 4
  }
  if (current === 1) {
    throw new Error('工作区由旧版本创建（v1 < v4）：目前不自动迁移，请备份后删除 .curation/ 并重新 curation_init（见 docs/DATABASE.md）')
  }
  db.exec(SCHEMA_V4)
  db.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}`)
  return db
}

const nowIso = () => new Date().toISOString()

/** Deterministic JSON for the migration's one-time pin hash. */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

function migrateV3toV4(db) {
  const contractRow = db.prepare('SELECT version, hash, json, signed_at FROM contract WHERE id = 1').get()
  const at = nowIso()
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA_V4_BASE)

    let tableId = null
    let tableConfig = null
    if (contractRow) {
      const contract = JSON.parse(contractRow.json)
      tableId = contract?.delivery?.table ?? null
      if (tableId) {
        tableConfig = {
          table: tableId,
          key: contract.delivery.key,
          purpose: null,
          status: 'active',
          records: contract.records,
          fields: contract.fields,
          channels: contract.channels,
          normalization: contract.normalization,
          evidence: contract.evidence,
          gates: contract.gates,
          ...(contract.adjudication ? { adjudication: contract.adjudication } : {}),
        }
      }
    }

    if (!db.prepare('SELECT id FROM project WHERE id = 1').get()) {
      db.prepare('INSERT INTO project (id, name, description, created_at, updated_at) VALUES (1, NULL, NULL, ?, ?)').run(at, at)
    }
    if (tableId && !db.prepare('SELECT table_id FROM table_registry WHERE table_id = ?').get(tableId)) {
      db.prepare(`INSERT INTO table_registry (table_id, delivery_table, purpose, status, created_at, updated_at)
        VALUES (?, ?, NULL, 'active', ?, ?)`).run(tableId, tableId, at, at)
    }

    // Rebuild submission so its uniqueness includes table_id (SQLite cannot
    // drop a constraint in place; keep ids so submission_value stays linked).
    const subCols = db.prepare("SELECT name FROM pragma_table_info('submission')").all().map((r) => r.name)
    if (subCols.includes('table_id') === false) {
      db.exec(`CREATE TABLE submission_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id TEXT NOT NULL REFERENCES table_registry(table_id),
        channel TEXT NOT NULL, batch TEXT NOT NULL, record TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('valid', 'uncertain', 'invalid')),
        submitted_at TEXT NOT NULL, notes TEXT,
        UNIQUE (table_id, channel, batch, record))`)
      if (tableId) {
        db.prepare(`INSERT INTO submission_new (id, table_id, channel, batch, record, status, submitted_at, notes)
          SELECT id, ?, channel, batch, record, status, submitted_at, notes FROM submission`).run(tableId)
      }
      db.exec('DROP TABLE submission')
      db.exec('ALTER TABLE submission_new RENAME TO submission')
    }
    if (tableId) db.prepare('UPDATE submission SET table_id = ?').run(tableId)

    // decision / ledger gain table + pin provenance columns.
    const addColumn = (table, name, decl) => {
      const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name)
      if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
    }
    for (const [name, decl] of [
      ['table_id', "TEXT NOT NULL DEFAULT ''"],
      ['pin_id', 'TEXT'],
      ['table_pin_id', 'INTEGER'],
    ]) addColumn('decision', name, decl)
    for (const [name, decl] of [
      ['table_id', "TEXT NOT NULL DEFAULT ''"],
      ['decision_id', 'INTEGER'],
      ['apply_run_id', 'TEXT'],
    ]) addColumn('ledger', name, decl)
    if (tableId) {
      db.prepare('UPDATE decision SET table_id = ?').run(tableId)
      db.prepare('UPDATE ledger SET table_id = ?').run(tableId)
    }

    // Now that every column exists, the rest of the v4 schema (indexes,
    // run/applied mirrors and the derived view) can be applied.
    db.exec(SCHEMA_V4)

    // Copy project-level runs/applied into their per-table mirrors.
    const tables = tableId ? [tableId] : []
    for (const tid of tables) {
      for (const r of db.prepare('SELECT * FROM run').all()) {
        if (!db.prepare('SELECT 1 FROM run_table WHERE run_id = ? AND table_id = ?').get(r.run_id, tid)) {
          db.prepare('INSERT INTO run_table (run_id, table_id, pin_id, summary) VALUES (?, ?, NULL, ?)')
            .run(r.run_id, tid, r.summary ?? '{}')
        }
      }
      for (const r of db.prepare('SELECT * FROM applied').all()) {
        if (!db.prepare('SELECT 1 FROM applied_table WHERE run_id = ? AND table_id = ?').get(r.run_id, tid)) {
          db.prepare('INSERT INTO applied_table (run_id, table_id, ops, delivery_table) VALUES (?, ?, ?, ?)')
            .run(r.run_id, tid, r.ops ?? 0, r.delivery_table ?? tid)
        }
      }
    }

    if (tableConfig) {
      const pinId = `pin-${Date.now().toString(36)}-migrate`
      const project = { name: null, description: null }
      const snapshot = {
        version: 5,
        project,
        defaults: {},
        tables: [tableConfig],
      }
      const pinJson = JSON.parse(JSON.stringify(snapshot))
      const pinHash = sha256(stableJson(pinJson))
      db.prepare('INSERT INTO pin (id, hash, json, algorithm, pinned_at) VALUES (?, ?, ?, ?, ?)')
        .run(pinId, pinHash, JSON.stringify(pinJson), 'sha256/canonical-json', at)
      const revision = 1
      const tableHash = sha256(stableJson(JSON.parse(JSON.stringify(tableConfig))))
      db.prepare(`INSERT INTO table_pin (aggregate_pin_id, table_id, revision, hash, json, legacy_contract_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(pinId, tableId, revision, tableHash, JSON.stringify(tableConfig), contractRow.hash, at)
      db.prepare('INSERT INTO project_event (at, kind, actor, text, pin_id) VALUES (?, ?, ?, ?, ?)')
        .run(at, 'auto', 'migration', `从 v3 工作区迁移：契约转为 pin（表 ${tableId}）`, pinId)
      db.prepare('INSERT INTO table_event (table_id, at, kind, text, pin_id, actor) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tableId, at, 'auto', '迁移创建首版 table_pin', pinId, 'migration')
      db.prepare("INSERT INTO meta (key, value) VALUES ('pin_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(pinHash)
    }

    db.exec('PRAGMA user_version = 4')
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw e
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
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
