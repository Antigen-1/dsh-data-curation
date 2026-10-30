// lib/store.js — the project workspace: one SQLite file plus its state directory.
//
// Layout (default .curation/):
//   project.sqlite       THE workspace: project/table registry/pins, exporters,
//                        submissions, decisions, ledger, runs and the curated
//                        tables all live here
//   manifest.json        source baseline: one entry per source file (never edited)
//   pin.sha256           seal for the aggregate pin stored in the database
//   pin.json             derived, human-readable mirror of the stored pin
//   pending.json         derived, human-readable mirror of unresolved cells
//   backups/             point-in-time copies of the workspace before a write
//   packs/               project archives produced by curation_pack
//
// Only manifest.json is authoritative outside the database, and it is derived
// from read-only sources: everything the tool may change lives in project.sqlite.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  ensureDir, nowIso, readJsonOr, resolveInside, writeJson,
} from './util.js'
import { PIN_ALGORITHM, tableHash } from './pin.js'
import {
  backupDb, ensureStateSchema, fromJson, getMeta, openDb, setMeta, toJson, withTransaction,
} from './db.js'

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export function createStore(cwd, stateDir = '.curation') {
  const dir = resolveInside(cwd, stateDir)
  const dbPath = join(dir, 'project.sqlite')

  const api = {
    cwd,
    dir,
    dbPath,
    manifestPath: join(dir, 'manifest.json'),
    sealPath: join(dir, 'pin.sha256'),
    pinMirrorPath: join(dir, 'pin.json'),
    pendingPath: join(dir, 'pending.json'),
    backupsDir: join(dir, 'backups'),
    packsDir: join(dir, 'packs'),

    async exists(p) {
      try {
        await fs.access(p)
        return true
      } catch {
        return false
      }
    },

    /** Open the workspace (creating the layout and schema when needed). */
    async withDb(fn) {
      await ensureDir(dir)
      const db = openDb(dbPath)
      try {
        db.exec('PRAGMA journal_mode = WAL')
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
        let backupPath = null
        if (version === 3) {
          await ensureDir(api.backupsDir)
          const stamp = nowIso().replace(/[:.]/g, '-')
          backupPath = join(api.backupsDir, `${stamp}__pre-v4.sqlite`)
        }
        ensureStateSchema(db, { backupPath })
        return await fn(db)
      } finally {
        db.close()
      }
    },

    /** Consistent snapshot of the workspace into an explicit path. */
    async snapshot(target) {
      return api.withDb((db) => backupDb(db, target))
    },

    // ---- frozen project files -------------------------------------------
    async readManifest() {
      return readJsonOr(api.manifestPath, null)
    },

    async writeManifest(manifest) {
      await writeJson(api.manifestPath, manifest)
    },

    // ---- project / pins (authority: database; seal + mirror for humans) --
    async readProject() {
      return api.withDb((db) => {
        const row = db.prepare('SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt FROM project WHERE id = 1').get()
        return row ? { ...row } : null
      })
    },

    async listTables() {
      return api.withDb((db) => db.prepare(`
        SELECT r.table_id AS tableId, r.delivery_table AS deliveryTable, r.purpose, r.status,
               r.created_at AS createdAt, r.updated_at AS updatedAt,
               tp.revision, tp.hash, tp.json, tp.aggregate_pin_id AS aggregatePinId
        FROM table_registry r
        LEFT JOIN table_pin tp ON tp.table_id = r.table_id
          AND tp.revision = (SELECT MAX(revision) FROM table_pin WHERE table_id = r.table_id)
        ORDER BY r.table_id
      `).all().map((r) => ({ ...r, config: fromJson(r.json, null) })))
    },

    async readPinRecord() {
      const row = await api.withDb((db) => db.prepare(
        'SELECT id, hash, json, algorithm, pinned_at AS pinnedAt FROM pin ORDER BY rowid DESC LIMIT 1',
      ).get())
      if (!row) return null
      return { id: row.id, hash: row.hash, algorithm: row.algorithm, pinnedAt: row.pinnedAt, pin: fromJson(row.json, null) }
    },

    async readPin() {
      return (await api.readPinRecord())?.pin ?? null
    },

    async readPinSeal() {
      try {
        return (await fs.readFile(api.sealPath, 'utf8')).trim()
      } catch (e) {
        if (e?.code === 'ENOENT') return null
        throw e
      }
    },

    async readTablePin(tableId) {
      const row = await api.withDb((db) => db.prepare(
        'SELECT * FROM table_pin WHERE table_id = ? ORDER BY revision DESC LIMIT 1',
      ).get(tableId))
      if (!row) return null
      return {
        id: row.id,
        aggregatePinId: row.aggregate_pin_id,
        tableId: row.table_id,
        revision: row.revision,
        hash: row.hash,
        legacyContractHash: row.legacy_contract_hash,
        createdAt: row.created_at,
        config: fromJson(row.json, null),
      }
    },

    /**
     * Store one aggregate pin plus its per-table effective configs.
     * `tables` is the validated result of validatePin().
     */
    async writePin({ pin, pinId, hash, tables, project = null }) {
      const at = nowIso()
      const id = pinId ?? `pin-${Date.now().toString(36)}`
      const actualHash = hash ?? tableHash(pin)
      await api.withDb((db) => withTransaction(db, () => {
        const projectRow = project ?? pin.project ?? {}
        db.prepare(`INSERT INTO project (id, name, description, created_at, updated_at) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at`)
          .run(projectRow.name ?? null, projectRow.description ?? null, at, at)
        for (const t of tables) {
          const declared = t.declared ?? {}
          db.prepare(`INSERT INTO table_registry (table_id, delivery_table, purpose, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(table_id) DO UPDATE SET purpose = excluded.purpose, status = excluded.status, updated_at = excluded.updated_at`)
            .run(t.tableId, t.tableId, declared.purpose ?? null, t.status ?? 'active', at, at)
        }
        db.prepare('INSERT INTO pin (id, hash, json, algorithm, pinned_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, actualHash, JSON.stringify(pin), PIN_ALGORITHM, at)
        for (const t of tables) {
          const row = db.prepare('SELECT MAX(revision) AS revision FROM table_pin WHERE table_id = ?').get(t.tableId)
          const revision = Number(row?.revision ?? 0) + 1
          db.prepare(`INSERT INTO table_pin (aggregate_pin_id, table_id, revision, hash, json, legacy_contract_hash, created_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?)`)
            .run(id, t.tableId, revision, t.effectiveHash ?? tableHash(t.effective), JSON.stringify(t.effective), at)
          db.prepare('INSERT INTO table_event (table_id, at, kind, text, pin_id, actor) VALUES (?, ?, ?, ?, ?, ?)')
            .run(t.tableId, at, 'auto', `签署 pin（revision ${revision}）`, id, 'pin')
        }
        db.prepare('INSERT INTO project_event (at, kind, actor, text, pin_id) VALUES (?, ?, ?, ?, ?)')
          .run(at, 'auto', 'pin', `签署聚合 pin ${id}（${tables.length} 张表）`, id)
        setMeta(db, 'pin_hash', actualHash)
        setMeta(db, 'pin_id', id)
        setMeta(db, 'pinned_at', at)
      }))
      await fs.writeFile(api.sealPath, `${actualHash}\n`, 'utf8')
      await writeJson(api.pinMirrorPath, pin)
      return actualHash
    },

    async listEvents({ tableId = null } = {}) {
      return api.withDb((db) => {
        const project = db.prepare('SELECT id, at, kind, actor, text, pin_id AS pinId FROM project_event ORDER BY id').all()
        const tables = tableId
          ? db.prepare('SELECT id, table_id AS tableId, at, kind, actor, text, pin_id AS pinId FROM table_event WHERE table_id = ? ORDER BY id').all(tableId)
          : db.prepare('SELECT id, table_id AS tableId, at, kind, actor, text, pin_id AS pinId FROM table_event ORDER BY id').all()
        return { project: project.map((r) => ({ ...r })), tables: tables.map((r) => ({ ...r })) }
      })
    },

    async addNote({ tableId = null, text, pinId = null }) {
      const at = nowIso()
      await api.withDb((db) => {
        if (tableId) {
          db.prepare('INSERT INTO table_event (table_id, at, kind, text, pin_id, actor) VALUES (?, ?, ?, ?, ?, ?)')
            .run(tableId, at, 'note', text, pinId, 'note')
        } else {
          db.prepare('INSERT INTO project_event (at, kind, actor, text, pin_id) VALUES (?, ?, ?, ?, ?)')
            .run(at, 'note', 'note', text, pinId)
        }
      })
      return { at, tableId, pinId }
    },

    async meta() {
      return api.withDb((db) => db.prepare('SELECT key, value FROM meta').all()
        .reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {}))
    },

    async getMeta(key) {
      return api.withDb((db) => getMeta(db, key))
    },

    // ---- exporters (mutable, hence in the database) ----------------------
    async listExporters() {
      return api.withDb((db) => db.prepare('SELECT name, command, args, created_at AS createdAt FROM exporter ORDER BY name')
        .all().map((r) => ({ name: r.name, command: r.command, args: fromJson(r.args, []), createdAt: r.createdAt })))
    },

    async upsertExporter({ name, command, args = [] }) {
      await api.withDb((db) => db.prepare(`INSERT INTO exporter (name, command, args, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET command = excluded.command, args = excluded.args`)
        .run(name, command, toJson(args ?? []), nowIso()))
    },

    async removeExporter(name) {
      return api.withDb((db) => db.prepare('DELETE FROM exporter WHERE name = ?').run(name).changes > 0)
    },

    // ---- submissions -----------------------------------------------------
    /** Store one table/channel/batch submission; re-submitting replaces it. */
    async insertSubmissions({ tableId, channel, batch, records, notes = null }) {
      if (!SAFE_NAME.test(channel)) throw new Error(`通道名只能包含字母数字._-：${channel}`)
      if (!SAFE_NAME.test(batch)) throw new Error(`批次名只能包含字母数字._-：${batch}`)
      return api.withDb((db) => withTransaction(db, () => {
        const submittedAt = nowIso()
        let count = 0
        for (const rec of records) {
          db.prepare('DELETE FROM submission WHERE table_id = ? AND channel = ? AND batch = ? AND record = ?')
            .run(tableId, channel, batch, String(rec.record_id))
          const ins = db.prepare(
            'INSERT INTO submission (table_id, channel, batch, record, status, submitted_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(tableId, channel, batch, String(rec.record_id), rec.status, submittedAt, notes)
          const id = Number(ins.lastInsertRowid)
          const val = db.prepare('INSERT INTO submission_value (submission_id, field, value, evidence) VALUES (?, ?, ?, ?)')
          for (const [field, value] of Object.entries(rec.values ?? {})) {
            val.run(id, field, value === null || value === undefined ? '' : String(value), toJson(rec.evidence?.[field] ?? null))
          }
          count += 1
        }
        return count
      }))
    },

    /** Latest submission per (channel, record) for one table, flattened by field. */
    async latestSubmissions(tableId) {
      return api.withDb((db) => db.prepare(`
        SELECT s.table_id AS tableId, s.channel, s.batch, s.record, s.status, s.submitted_at AS submittedAt,
               v.field, v.value, v.evidence
        FROM submission s
        JOIN submission_value v ON v.submission_id = s.id
        JOIN (SELECT MAX(id) AS id FROM submission WHERE table_id = ? GROUP BY channel, record) m ON m.id = s.id
        ORDER BY s.id, v.field
      `).all(tableId).map((row) => ({ ...row, evidence: fromJson(row.evidence, null) })))
    },

    async channelStats(tableId) {
      return api.withDb((db) => db.prepare(`
        SELECT channel, COUNT(*) AS submissions, MAX(submitted_at) AS lastAt
        FROM submission ${tableId ? 'WHERE table_id = ?' : ''} GROUP BY channel ORDER BY channel
      `).all(...(tableId ? [tableId] : [])).map((r) => ({ ...r })))
    },

    // ---- decisions -------------------------------------------------------
    async latestDecisions(tableId) {
      return api.withDb((db) => db.prepare(`
        SELECT d.* FROM decision d
        JOIN (SELECT MAX(id) AS id FROM decision WHERE table_id = ? GROUP BY record, field) m ON d.id = m.id
        ORDER BY d.record, d.field
      `).all(tableId).map(decodeDecision))
    },

    async decisionCount(tableId = null) {
      return api.withDb((db) => (tableId
        ? db.prepare('SELECT COUNT(*) AS c FROM decision WHERE table_id = ?').get(tableId).c
        : db.prepare('SELECT COUNT(*) AS c FROM decision').get().c))
    },

    async staleCells({ tableId, records, fields } = {}) {
      return api.withDb((db) => {
        const where = ['sub.table_id = ?']
        const params = [tableId]
        if (Array.isArray(records) && records.length) {
          where.push(`sub.record IN (${records.map(() => '?').join(',')})`)
          params.push(...records.map(String))
        }
        if (Array.isArray(fields) && fields.length) {
          where.push(`sub.field IN (${fields.map(() => '?').join(',')})`)
          params.push(...fields.map(String))
        }
        return db.prepare(`
          WITH sub AS (
            SELECT s.table_id AS table_id, s.record AS record, v.field AS field, MAX(s.submitted_at) AS last_sub
            FROM submission s JOIN submission_value v ON v.submission_id = s.id
            GROUP BY s.table_id, s.record, v.field
          ), dec AS (
            SELECT table_id, record, field, MAX(id) AS id FROM decision GROUP BY table_id, record, field
          )
          SELECT sub.record, sub.field, sub.last_sub, d.decided_at
          FROM sub
          LEFT JOIN dec ON dec.table_id = sub.table_id AND dec.record = sub.record AND dec.field = sub.field
          LEFT JOIN decision d ON d.id = dec.id
          WHERE (d.id IS NULL OR sub.last_sub >= d.decided_at) AND ${where.join(' AND ')}
          ORDER BY sub.record, sub.field
        `).all(...params).map((r) => ({ record: r.record, field: r.field, lastSubmissionAt: r.last_sub, decidedAt: r.decided_at }))
      })
    },

    /** Newest run for one table (or any table when tableId is omitted). */
    async latestRun(kind = 'compare', tableId = null) {
      return api.withDb((db) => {
        const row = tableId
          ? db.prepare(`SELECT r.run_id, r.kind, r.created_at, t.summary FROM run r JOIN run_table t ON t.run_id = r.run_id
              WHERE r.kind = ? AND t.table_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`).get(kind, tableId)
          : db.prepare('SELECT run_id, kind, created_at, summary FROM run WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(kind)
        return row ? { runId: row.run_id, kind: row.kind, createdAt: row.created_at, summary: fromJson(row.summary, null) } : null
      })
    },

    async writePending(runId, items) {
      await writeJson(api.pendingPath, { runId, updatedAt: nowIso(), items })
    },

    async readPending() {
      return readJsonOr(api.pendingPath, { items: [] })
    },

    // ---- ledger ----------------------------------------------------------
    /** Latest ledger row per (table, record, field): last written value. */
    async latestLedger(tableId) {
      return api.withDb((db) => db.prepare(`
        SELECT l.* FROM ledger l
        JOIN (SELECT MAX(id) AS id FROM ledger WHERE table_id = ? GROUP BY record, field) m ON l.id = m.id
      `).all(tableId).map((r) => ({ ...r })))
    },

    async ledgerCount(tableId = null) {
      return api.withDb((db) => (tableId
        ? db.prepare('SELECT COUNT(*) AS c FROM ledger WHERE table_id = ?').get(tableId).c
        : db.prepare('SELECT COUNT(*) AS c FROM ledger').get().c))
    },

    // ---- runs ------------------------------------------------------------
    async getRun(runId) {
      const row = await api.withDb((db) => db.prepare('SELECT * FROM run WHERE run_id = ?').get(runId))
      if (!row) return null
      const tables = await api.withDb((db) => db.prepare('SELECT table_id AS tableId, pin_id AS pinId, summary FROM run_table WHERE run_id = ?').all(runId))
      return { ...row, summary: fromJson(row.summary, {}), tables: tables.map((t) => ({ ...t, summary: fromJson(t.summary, {}) })) }
    },

    async runStats() {
      return api.withDb((db) => db.prepare('SELECT kind, COUNT(*) AS c, MAX(created_at) AS lastAt FROM run GROUP BY kind').all().map((r) => ({ ...r })))
    },

    // ---- applied ---------------------------------------------------------
    async readApplied() {
      const row = await api.withDb((db) => db.prepare('SELECT * FROM applied ORDER BY rowid DESC LIMIT 1').get())
      if (!row) return null
      const tables = await api.withDb((db) => db.prepare('SELECT table_id AS tableId, ops, delivery_table AS deliveryTable FROM applied_table WHERE run_id = ?').all(row.run_id))
      return { ...row, tables }
    },
  }
  return api
}


// ---- statement-level helpers ------------------------------------------------
//
// These take an open connection and never start a transaction: the caller owns
// the BEGIN … COMMIT. That is what lets compare and apply write their whole
// outcome atomically instead of across several short transactions.

/** Insert one decision row per cell (append-only). */
export function insertDecisionsTx(db, { tableId, runId, pinId = null, tablePinId = null, decisions }) {
  const stmt = db.prepare(`
    INSERT INTO decision (table_id, run_id, pin_id, table_pin_id, record, field, status, value, normalized, adopted, dissent, votes, reason, evidence, synthesized, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const at = nowIso()
  for (const d of decisions) {
    stmt.run(
      tableId, runId, pinId, tablePinId, String(d.record), d.field, d.status,
      d.value === null || d.value === undefined ? null : String(d.value),
      d.normalized ?? null, toJson(d.adopted ?? []), toJson(d.dissent ?? []),
      toJson(d.votes ?? []), d.reason ?? null, toJson(d.evidence ?? []), d.synthesized ? 1 : 0, at,
    )
  }
  return decisions.length
}

/** Append one ledger row per written cell. */
export function insertLedgerTx(db, tableId, rows) {
  const stmt = db.prepare(`
    INSERT INTO ledger (table_id, applied_at, record, field, old_value, new_value, adopted, dissent, evidence, run_id, decision_id, apply_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const r of rows) {
    stmt.run(tableId, r.applied_at, r.record, r.field,
      r.old === null || r.old === undefined ? null : String(r.old),
      r.new === null || r.new === undefined ? null : String(r.new),
      toJson(r.adopted ?? []), toJson(r.dissent ?? []), toJson(r.evidence ?? []),
      r.run_id ?? null, r.decision_id ?? null, r.apply_run_id ?? null)
  }
  return rows.length
}

/** Record a run summary plus one row per touched table. */
export function insertRunTx(db, { runId, kind, summary, tables = [] }) {
  db.prepare('INSERT INTO run (run_id, kind, created_at, summary) VALUES (?, ?, ?, ?)')
    .run(runId, kind, nowIso(), toJson(summary) ?? '{}')
  for (const t of tables) {
    db.prepare('INSERT OR REPLACE INTO run_table (run_id, table_id, pin_id, summary) VALUES (?, ?, ?, ?)')
      .run(runId, t.tableId, t.pinId ?? null, toJson(t.summary ?? {}) ?? '{}')
  }
}

/** Record the outcome of one apply (one project row + one row per table). */
export function writeAppliedTx(db, entry) {
  db.prepare('INSERT OR REPLACE INTO applied (run_id, applied_at, ops, backup, delivery_table) VALUES (?, ?, ?, ?, ?)')
    .run(entry.runId, entry.appliedAt, entry.ops, entry.backup ?? null, entry.deliveryTable ?? null)
  for (const t of entry.tables ?? []) {
    db.prepare('INSERT OR REPLACE INTO applied_table (run_id, table_id, ops, delivery_table) VALUES (?, ?, ?, ?)')
      .run(entry.runId, t.tableId, t.ops ?? entry.ops, t.deliveryTable ?? null)
  }
}

function decodeDecision(row) {
  return {
    ...row,
    synthesized: Boolean(row.synthesized),
    adopted: fromJson(row.adopted, []),
    dissent: fromJson(row.dissent, []),
    votes: fromJson(row.votes, []),
    evidence: fromJson(row.evidence, []),
  }
}

export { decodeDecision }
