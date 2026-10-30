// lib/query.js — read-only access to the workspace (no writes, no locks).
//
// Every function takes an already-opened DatabaseSync (read-only connection) and
// returns plain JSON-friendly data. The tool layer only renders it.

const DEFAULT_LIMIT = 50

function limitOf(value, fallback = DEFAULT_LIMIT) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`limit 必须是正整数：${value}`)
  return n
}

function parseJson(text, fallback) {
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function count(db, sql, ...params) {
  return db.prepare(sql).get(...params)?.n ?? 0
}

/** Aggregate view: what a dashboard would show. */
export function queryCounts(db) {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM decision GROUP BY status').all()
  const decisions = { total: 0, accepted: 0, pending: 0, byReason: {}, byField: [] }
  for (const row of byStatus) {
    decisions.total += row.n
    if (row.status === 'accepted') decisions.accepted += row.n
    else decisions.pending += row.n
  }
  for (const row of db.prepare(`SELECT reason, COUNT(*) AS n FROM decision WHERE status = 'pending' GROUP BY reason ORDER BY n DESC`).all()) {
    decisions.byReason[row.reason ?? 'unknown'] = row.n
  }
  decisions.byField = db.prepare(`
    SELECT field,
           SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM decision GROUP BY field ORDER BY field
  `).all().map((r) => ({ field: r.field, accepted: r.accepted ?? 0, pending: r.pending ?? 0 }))

  const submissions = db.prepare(`
    SELECT channel, COUNT(DISTINCT batch) AS batches, COUNT(*) AS records
    FROM submission GROUP BY channel ORDER BY channel
  `).all().map((r) => ({ channel: r.channel, batches: r.batches, records: r.records }))
  const values = count(db, 'SELECT COUNT(*) AS n FROM submission_value')

  const runs = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM run').get()
  const applied = db.prepare('SELECT run_id, applied_at, ops FROM applied ORDER BY rowid DESC LIMIT 1').get()
  return {
    decisions,
    submissions,
    values,
    runs: { total: runs?.n ?? 0, lastAt: runs?.last ?? null },
    applied: applied ? { runId: applied.run_id, appliedAt: applied.applied_at, ops: applied.ops } : null,
  }
}

/** Pending cells with their reason and the votes that were present. */
export function queryPending(db, { reason, record, limit } = {}) {
  const lim = limitOf(limit)
  const where = ["status = 'pending'"]
  const params = []
  if (reason) { where.push('reason = ?'); params.push(String(reason)) }
  if (record) { where.push('record = ?'); params.push(String(record)) }
  const rows = db.prepare(`
    SELECT record, field, reason, votes, decided_at
    FROM decision WHERE ${where.join(' AND ')}
    ORDER BY record, field LIMIT ?
  `).all(...params, lim)
  return rows.map((r) => ({
    record: r.record,
    field: r.field,
    reason: r.reason,
    channels: parseJson(r.votes, []).filter((v) => v.valid && v.present).map((v) => `${v.channel}=${v.raw}`),
    decidedAt: r.decided_at,
  }))
}

/** Latest decision per cell, optionally filtered. */
export function queryCells(db, { record, field, status, limit } = {}) {
  const lim = limitOf(limit)
  const where = []
  const params = []
  if (record) { where.push('d.record = ?'); params.push(String(record)) }
  if (field) { where.push('d.field = ?'); params.push(String(field)) }
  if (status) { where.push('d.status = ?'); params.push(String(status)) }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT d.record, d.field, d.status, d.value, d.normalized, d.adopted, d.dissent,
           d.reason, d.synthesized, d.run_id, d.decided_at
    FROM decision d
    JOIN (SELECT record, field, MAX(id) AS id FROM decision GROUP BY record, field) latest
      ON latest.id = d.id
    ${filter}
    ORDER BY d.record, d.field LIMIT ?
  `).all(...params, lim)
  return rows.map((r) => ({
    record: r.record,
    field: r.field,
    status: r.status,
    value: r.value,
    normalized: r.normalized,
    adopted: parseJson(r.adopted, []),
    dissent: parseJson(r.dissent, []),
    reason: r.reason,
    synthesized: Boolean(r.synthesized),
    runId: r.run_id,
    decidedAt: r.decided_at,
  }))
}

/** The votes behind one cell (latest decision). */
export function queryVotes(db, { record, field } = {}) {
  if (!record || !field) throw new Error('votes 查询需要 record 与 field')
  const row = db.prepare(`
    SELECT votes, status, reason FROM decision
    WHERE record = ? AND field = ?
    ORDER BY id DESC LIMIT 1
  `).get(String(record), String(field))
  if (!row) return { record, field, found: false, votes: [] }
  return {
    record,
    field,
    found: true,
    status: row.status,
    reason: row.reason,
    votes: parseJson(row.votes, []),
  }
}

/** Submission batches with the fields they carried. */
export function querySubmissions(db, { channel, record, limit } = {}) {
  const lim = limitOf(limit)
  const where = []
  const params = []
  if (channel) { where.push('s.channel = ?'); params.push(String(channel)) }
  if (record) { where.push('s.record = ?'); params.push(String(record)) }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT s.id, s.channel, s.batch, s.record, s.status, s.submitted_at,
           (SELECT COUNT(*) FROM submission_value v WHERE v.submission_id = s.id) AS fields
    FROM submission s ${filter}
    ORDER BY s.id DESC LIMIT ?
  `).all(...params, lim)
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    batch: r.batch,
    record: r.record,
    status: r.status,
    fields: r.fields,
    submittedAt: r.submitted_at,
  }))
}

/** Compare runs (newest first). */
export function queryRuns(db, { limit } = {}) {
  const lim = limitOf(limit)
  return db.prepare('SELECT run_id, kind, summary, created_at FROM run ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(lim)
    .map((r) => ({ runId: r.run_id, kind: r.kind, summary: parseJson(r.summary, null), createdAt: r.created_at }))
}

/** Table inventory: plugin tables plus the curated tables, with row counts. */
export function querySchema(db, { limit } = {}) {
  void limit
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name)
  return tables.map((name) => {
    const columns = db.prepare(`PRAGMA table_info('${name.replaceAll("'", "''")}')`).all()
      .map((c) => ({ name: c.name, type: c.type, notNull: Boolean(c.notnull) }))
    const rows = hasTable(db, name) ? count(db, `SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`) : 0
    return { table: name, rows, columns }
  })
}

export const QUERY_KINDS = ['counts', 'pending', 'cells', 'votes', 'submissions', 'runs', 'schema']

export function runQuery(db, { what, ...filters }) {
  switch (what) {
    case 'counts': return queryCounts(db)
    case 'pending': return queryPending(db, filters)
    case 'cells': return queryCells(db, filters)
    case 'votes': return queryVotes(db, filters)
    case 'submissions': return querySubmissions(db, filters)
    case 'runs': return queryRuns(db, filters)
    case 'schema': return querySchema(db, filters)
    default: throw new Error(`未知的查询类型：${what}（可用：${QUERY_KINDS.join(', ')}）`)
  }
}
