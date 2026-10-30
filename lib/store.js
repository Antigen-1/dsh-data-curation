// lib/store.js — the project workspace: one SQLite file plus its state directory.
//
// Layout (default .curation/):
//   project.sqlite       THE workspace: contract, exporters, submissions,
//                        decisions, ledger, runs and the curated table all live here
//   manifest.json        source baseline: one entry per source file (never edited)
//   contract.sha256      seal for the contract stored in the database
//   contract.json        derived, human-readable mirror of the stored contract
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
import { contractHash } from './contract.js'
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
    sealPath: join(dir, 'contract.sha256'),
    contractMirrorPath: join(dir, 'contract.json'),
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
        ensureStateSchema(db)
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

    // ---- contract (authority: database; seal + mirror for humans) --------
    async readContractRecord() {
      const row = await api.withDb((db) => db.prepare('SELECT version, hash, json, signed_at AS signedAt FROM contract WHERE id = 1').get())
      if (!row) return null
      return { version: row.version, hash: row.hash, signedAt: row.signedAt, contract: fromJson(row.json, null) }
    },

    async readContract() {
      const rec = await api.readContractRecord()
      return rec?.contract ?? null
    },

    /** The seal is the tamper anchor: it lives outside the database on purpose. */
    async readContractSeal() {
      try {
        return (await fs.readFile(api.sealPath, 'utf8')).trim()
      } catch (e) {
        if (e?.code === 'ENOENT') return null
        throw e
      }
    },

    async writeContract(contract) {
      const hash = contractHash(contract)
      const signedAt = nowIso()
      await api.withDb((db) => withTransaction(db, () => {
        db.prepare(`INSERT INTO contract (id, version, hash, json, signed_at) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET version = excluded.version, hash = excluded.hash,
          json = excluded.json, signed_at = excluded.signed_at`)
          .run(contract.version ?? 0, hash, JSON.stringify(contract), signedAt)
        setMeta(db, 'contract_hash', hash)
        setMeta(db, 'contract_signed_at', signedAt)
      }))
      await fs.writeFile(api.sealPath, `${hash}\n`, 'utf8')
      await writeJson(api.contractMirrorPath, contract)
      return hash
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
    /** Store one channel/batch submission; re-submitting the same batch replaces it. */
    async insertSubmissions({ channel, batch, records, notes = null }) {
      if (!SAFE_NAME.test(channel)) throw new Error(`通道名只能包含字母数字._-：${channel}`)
      if (!SAFE_NAME.test(batch)) throw new Error(`批次名只能包含字母数字._-：${batch}`)
      return api.withDb((db) => withTransaction(db, () => {
        const submittedAt = nowIso()
        let count = 0
        for (const rec of records) {
          db.prepare('DELETE FROM submission WHERE channel = ? AND batch = ? AND record = ?')
            .run(channel, batch, String(rec.record_id))
          const ins = db.prepare(
            'INSERT INTO submission (channel, batch, record, status, submitted_at, notes) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(channel, batch, String(rec.record_id), rec.status, submittedAt, notes)
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

    /** Latest submission per (channel, record), flattened by field. */
    async latestSubmissions() {
      return api.withDb((db) => db.prepare(`
        SELECT s.channel, s.batch, s.record, s.status, s.submitted_at AS submittedAt,
               v.field, v.value, v.evidence
        FROM submission s
        JOIN submission_value v ON v.submission_id = s.id
        JOIN (SELECT MAX(id) AS id FROM submission GROUP BY channel, record) m ON m.id = s.id
        ORDER BY s.id, v.field
      `).all().map((row) => ({ ...row, evidence: fromJson(row.evidence, null) })))
    },

    /** Channels that submitted anything for each record (latest per channel). */
    async submittedChannels() {
      return api.withDb((db) => db.prepare(`
        SELECT s.record, s.channel
        FROM submission s
        JOIN (SELECT MAX(id) AS id FROM submission GROUP BY channel, record) m ON m.id = s.id
      `).all().map((r) => ({ ...r })))
    },

    async channelStats() {
      return api.withDb((db) => db.prepare(`
        SELECT channel, COUNT(*) AS submissions, MAX(submitted_at) AS lastAt
        FROM submission GROUP BY channel ORDER BY channel
      `).all().map((r) => ({ ...r })))
    },

    // ---- decisions -------------------------------------------------------
    async insertDecisions(runId, decisions) {
      return api.withDb((db) => withTransaction(db, () => insertDecisionsTx(db, runId, decisions)))
    },

    /** Latest decision per (record, field); later runs win. */
    async latestDecisions() {
      return api.withDb((db) => db.prepare(`
        SELECT d.* FROM decision d
        JOIN (SELECT MAX(id) AS id FROM decision GROUP BY record, field) m ON d.id = m.id
        ORDER BY d.record, d.field
      `).all().map(decodeDecision))
    },

    async decisionCount() {
      return api.withDb((db) => db.prepare('SELECT COUNT(*) AS c FROM decision').get().c)
    },

    async runDecisionCount(runId) {
      return api.withDb((db) => db.prepare('SELECT COUNT(*) AS c FROM decision WHERE run_id = ?').get(runId).c)
    },

    // ---- pending mirror --------------------------------------------------
    /** Cells whose newest submission is at least as new as their newest decision. */
    async staleCells({ records, fields } = {}) {
      return api.withDb((db) => {
        const where = []
        const params = []
        if (Array.isArray(records) && records.length) {
          where.push(`sub.record IN (${records.map(() => '?').join(',')})`)
          params.push(...records.map(String))
        }
        if (Array.isArray(fields) && fields.length) {
          where.push(`sub.field IN (${fields.map(() => '?').join(',')})`)
          params.push(...fields.map(String))
        }
        const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
        return db.prepare(`
          WITH sub AS (
            SELECT s.record AS record, v.field AS field, MAX(s.submitted_at) AS last_sub
            FROM submission s JOIN submission_value v ON v.submission_id = s.id
            GROUP BY s.record, v.field
          ), dec AS (
            SELECT record, field, MAX(id) AS id FROM decision GROUP BY record, field
          )
          SELECT sub.record, sub.field, sub.last_sub, d.decided_at
          FROM sub
          LEFT JOIN dec ON dec.record = sub.record AND dec.field = sub.field
          LEFT JOIN decision d ON d.id = dec.id
          WHERE (d.id IS NULL OR sub.last_sub >= d.decided_at) ${filter ? `AND ${filter.replace(/^WHERE /, '')}` : ''}
          ORDER BY sub.record, sub.field
        `).all(...params).map((r) => ({ record: r.record, field: r.field, lastSubmissionAt: r.last_sub, decidedAt: r.decided_at }))
      })
    },

    /** Newest compare run (or any run when kind is omitted). */
    async latestRun(kind = 'compare') {
      return api.withDb((db) => {
        const row = db.prepare('SELECT run_id, kind, created_at, summary FROM run WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(kind)
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
    async insertLedger(rows) {
      return api.withDb((db) => withTransaction(db, () => insertLedgerTx(db, rows)))
    },

    /** Latest ledger row per (record, field): what the table was last written to. */
    async latestLedger() {
      return api.withDb((db) => db.prepare(`
        SELECT l.* FROM ledger l
        JOIN (SELECT MAX(id) AS id FROM ledger GROUP BY record, field) m ON l.id = m.id
      `).all().map((r) => ({ ...r })))
    },

    async ledgerCount() {
      return api.withDb((db) => db.prepare('SELECT COUNT(*) AS c FROM ledger').get().c)
    },

    // ---- runs ------------------------------------------------------------
    async insertRun(runId, kind, summary) {
      await api.withDb((db) => insertRunTx(db, runId, kind, summary))
    },

    async getRun(runId) {
      const row = await api.withDb((db) => db.prepare('SELECT * FROM run WHERE run_id = ?').get(runId))
      return row ? { ...row, summary: fromJson(row.summary, {}) } : null
    },

    async runStats() {
      return api.withDb((db) => db.prepare('SELECT kind, COUNT(*) AS c, MAX(created_at) AS lastAt FROM run GROUP BY kind').all().map((r) => ({ ...r })))
    },

    // ---- applied ---------------------------------------------------------
    async writeApplied(entry) {
      await api.withDb((db) => withTransaction(db, () => writeAppliedTx(db, entry)))
    },

    async readApplied() {
      const row = await api.withDb((db) => db.prepare('SELECT * FROM applied ORDER BY rowid DESC LIMIT 1').get())
      return row ? { ...row } : null
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
export function insertDecisionsTx(db, runId, decisions) {
  const stmt = db.prepare(`
    INSERT INTO decision (run_id, record, field, status, value, normalized, adopted, dissent, votes, reason, evidence, synthesized, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const at = nowIso()
  for (const d of decisions) {
    stmt.run(
      runId, String(d.record), d.field, d.status,
      d.value === null || d.value === undefined ? null : String(d.value),
      d.normalized ?? null, toJson(d.adopted ?? []), toJson(d.dissent ?? []),
      toJson(d.votes ?? []), d.reason ?? null, toJson(d.evidence ?? []), d.synthesized ? 1 : 0, at,
    )
  }
  return decisions.length
}

/** Append one ledger row per written cell. */
export function insertLedgerTx(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO ledger (applied_at, record, field, old_value, new_value, adopted, dissent, evidence, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const r of rows) {
    stmt.run(r.applied_at, r.record, r.field,
      r.old === null || r.old === undefined ? null : String(r.old),
      r.new === null || r.new === undefined ? null : String(r.new),
      toJson(r.adopted ?? []), toJson(r.dissent ?? []), toJson(r.evidence ?? []), r.run_id ?? null)
  }
  return rows.length
}

/** Record a compare/apply run summary. */
export function insertRunTx(db, runId, kind, summary) {
  db.prepare('INSERT INTO run (run_id, kind, created_at, summary) VALUES (?, ?, ?, ?)')
    .run(runId, kind, nowIso(), toJson(summary) ?? '{}')
}

/** Record the outcome of one apply (one row per run). */
export function writeAppliedTx(db, entry) {
  db.prepare('INSERT OR REPLACE INTO applied (run_id, applied_at, ops, backup, delivery_table) VALUES (?, ?, ?, ?, ?)')
    .run(entry.runId, entry.appliedAt, entry.ops, entry.backup ?? null, entry.deliveryTable ?? null)
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
