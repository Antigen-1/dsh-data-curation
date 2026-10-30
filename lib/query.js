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

function tableFilter(where, params, table, column = 'table_id') {
  if (table) { where.push(`${column} = ?`); params.push(String(table)) }
}

/** Aggregate view: what a dashboard would show. */
export function queryCounts(db, { table } = {}) {
  const dWhere = []
  const dParams = []
  tableFilter(dWhere, dParams, table)
  const dFilter = dWhere.length ? `WHERE ${dWhere.join(' AND ')}` : ''
  const decisions = { total: 0, accepted: 0, pending: 0, byReason: {}, byField: [] }
  for (const row of db.prepare(`SELECT status, COUNT(*) AS n FROM decision ${dFilter} GROUP BY status`).all(...dParams)) {
    decisions.total += row.n
    if (row.status === 'accepted') decisions.accepted += row.n
    else decisions.pending += row.n
  }
  const rWhere = ["status = 'pending'"]
  const rParams = []
  tableFilter(rWhere, rParams, table)
  for (const row of db.prepare(`SELECT reason, COUNT(*) AS n FROM decision WHERE ${rWhere.join(' AND ')} GROUP BY reason ORDER BY n DESC`).all(...rParams)) {
    decisions.byReason[row.reason ?? 'unknown'] = row.n
  }
  decisions.byField = db.prepare(`
    SELECT field,
           SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM decision ${dFilter} GROUP BY field ORDER BY field
  `).all(...dParams).map((r) => ({ field: r.field, accepted: r.accepted ?? 0, pending: r.pending ?? 0 }))

  const sWhere = []
  const sParams = []
  tableFilter(sWhere, sParams, table)
  const sFilter = sWhere.length ? `WHERE ${sWhere.join(' AND ')}` : ''
  const submissions = db.prepare(`
    SELECT channel, COUNT(DISTINCT batch) AS batches, COUNT(*) AS records
    FROM submission ${sFilter} GROUP BY channel ORDER BY channel
  `).all(...sParams).map((r) => ({ channel: r.channel, batches: r.batches, records: r.records }))
  const valuesSql = sWhere.length
    ? `SELECT COUNT(*) AS n FROM submission_value v JOIN submission s ON s.id = v.submission_id WHERE ${sWhere.map((w) => w.replace('table_id', 's.table_id')).join(' AND ')}`
    : 'SELECT COUNT(*) AS n FROM submission_value'
  const values = count(db, valuesSql, ...sParams)

  const runs = table
    ? db.prepare('SELECT COUNT(*) AS n, MAX(r.created_at) AS last FROM run_table rt JOIN run r ON r.run_id = rt.run_id WHERE rt.table_id = ?').get(table)
    : db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM run').get()
  const applied = table
    ? db.prepare('SELECT a.run_id, a.applied_at, at2.ops FROM applied_table at2 JOIN applied a ON a.run_id = at2.run_id WHERE at2.table_id = ? ORDER BY a.rowid DESC LIMIT 1').get(table)
    : db.prepare('SELECT run_id, applied_at, ops FROM applied ORDER BY rowid DESC LIMIT 1').get()
  const tables = db.prepare(`
    SELECT r.table_id AS "table", r.status, tp.revision
    FROM table_registry r
    LEFT JOIN table_pin tp ON tp.table_id = r.table_id
      AND tp.revision = (SELECT MAX(revision) FROM table_pin WHERE table_id = r.table_id)
    ORDER BY r.table_id
  `).all().map((r) => ({ table: r.table, status: r.status, revision: r.revision ?? null }))
  return {
    tables,
    decisions,
    submissions,
    values,
    runs: { total: runs?.n ?? 0, lastAt: runs?.last ?? null },
    applied: applied ? { runId: applied.run_id, appliedAt: applied.applied_at, ops: applied.ops } : null,
  }
}

/** Pending cells with their reason and the votes that were present. */
export function queryPending(db, { reason, record, table, limit } = {}) {
  const lim = limitOf(limit)
  const where = ["status = 'pending'"]
  const params = []
  if (reason) { where.push('reason = ?'); params.push(String(reason)) }
  if (record) { where.push('record = ?'); params.push(String(record)) }
  tableFilter(where, params, table)
  const rows = db.prepare(`
    SELECT table_id, record, field, reason, votes, decided_at
    FROM decision WHERE ${where.join(' AND ')}
    ORDER BY table_id, record, field LIMIT ?
  `).all(...params, lim)
  return rows.map((r) => ({
    table: r.table_id,
    record: r.record,
    field: r.field,
    reason: r.reason,
    channels: parseJson(r.votes, []).filter((v) => v.valid && v.present).map((v) => `${v.channel}=${v.raw}`),
    decidedAt: r.decided_at,
  }))
}

/** Latest decision per cell, optionally filtered. */
export function queryCells(db, { record, field, status, table, limit } = {}) {
  const lim = limitOf(limit)
  const where = []
  const params = []
  if (record) { where.push('d.record = ?'); params.push(String(record)) }
  if (field) { where.push('d.field = ?'); params.push(String(field)) }
  if (status) { where.push('d.status = ?'); params.push(String(status)) }
  tableFilter(where, params, table, 'd.table_id')
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT d.table_id, d.record, d.field, d.status, d.value, d.normalized, d.adopted, d.dissent,
           d.reason, d.synthesized, d.run_id, d.decided_at
    FROM decision d
    JOIN (SELECT table_id, record, field, MAX(id) AS id FROM decision GROUP BY table_id, record, field) latest
      ON latest.id = d.id
    ${filter}
    ORDER BY d.table_id, d.record, d.field LIMIT ?
  `).all(...params, lim)
  return rows.map((r) => ({
    table: r.table_id,
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
export function queryVotes(db, { record, field, table } = {}) {
  if (!record || !field) throw new Error('votes 查询需要 record 与 field')
  const where = ['record = ?', 'field = ?']
  const params = [String(record), String(field)]
  tableFilter(where, params, table)
  const row = db.prepare(`
    SELECT table_id, votes, status, reason FROM decision
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC LIMIT 1
  `).get(...params)
  if (!row) return { table: table ?? null, record, field, found: false, votes: [] }
  return {
    table: row.table_id,
    record,
    field,
    found: true,
    status: row.status,
    reason: row.reason,
    votes: parseJson(row.votes, []),
  }
}

/** Submission batches with the fields they carried. */
export function querySubmissions(db, { channel, record, table, limit } = {}) {
  const lim = limitOf(limit)
  const where = []
  const params = []
  if (channel) { where.push('s.channel = ?'); params.push(String(channel)) }
  if (record) { where.push('s.record = ?'); params.push(String(record)) }
  tableFilter(where, params, table, 's.table_id')
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT s.id, s.table_id, s.channel, s.batch, s.record, s.status, s.submitted_at,
           (SELECT COUNT(*) FROM submission_value v WHERE v.submission_id = s.id) AS fields
    FROM submission s ${filter}
    ORDER BY s.id DESC LIMIT ?
  `).all(...params, lim)
  return rows.map((r) => ({
    id: r.id,
    table: r.table_id,
    channel: r.channel,
    batch: r.batch,
    record: r.record,
    status: r.status,
    fields: r.fields,
    submittedAt: r.submitted_at,
  }))
}

/** Compare runs per table (newest first). */
export function queryRuns(db, { table, limit } = {}) {
  const lim = limitOf(limit)
  const where = []
  const params = []
  tableFilter(where, params, table, 'rt.table_id')
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db.prepare(`
    SELECT rt.run_id, rt.table_id, rt.pin_id, rt.summary, r.kind, r.created_at
    FROM run_table rt LEFT JOIN run r ON r.run_id = rt.run_id
    ${filter}
    ORDER BY rt.rowid DESC LIMIT ?
  `).all(...params, lim).map((r) => ({
    runId: r.run_id,
    table: r.table_id,
    pinId: r.pin_id,
    kind: r.kind ?? 'compare',
    summary: parseJson(r.summary, null),
    createdAt: r.created_at,
  }))
}

/** Project metadata: project row, latest pin, registry, exporters, meta keys. */
export function queryMeta(db) {
  const project = db.prepare('SELECT id, name, description, created_at, updated_at FROM project WHERE id = 1').get() ?? null
  const pin = db.prepare('SELECT id, hash, algorithm, pinned_at FROM pin ORDER BY rowid DESC LIMIT 1').get() ?? null
  const tables = db.prepare(`
    SELECT r.table_id AS "table", r.status, r.purpose, tp.revision, tp.hash
    FROM table_registry r
    LEFT JOIN table_pin tp ON tp.table_id = r.table_id
      AND tp.revision = (SELECT MAX(revision) FROM table_pin WHERE table_id = r.table_id)
    ORDER BY r.table_id
  `).all().map((r) => ({ ...r }))
  const exporters = hasTable(db, 'exporter')
    ? db.prepare('SELECT name, command, args FROM exporter ORDER BY name').all().map((r) => ({ ...r, args: parseJson(r.args, []) }))
    : []
  const meta = hasTable(db, 'meta')
    ? db.prepare('SELECT key, value FROM meta ORDER BY key').all().reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {})
    : {}
  return {
    project: project && { name: project.name, description: project.description, createdAt: project.created_at, updatedAt: project.updated_at },
    pin: pin && { id: pin.id, hash: pin.hash, algorithm: pin.algorithm, pinnedAt: pin.pinned_at },
    tables,
    exporters,
    meta,
  }
}

/** Project- and table-scoped events (newest first). */
export function queryEvents(db, { table, kind, limit } = {}) {
  const lim = limitOf(limit)
  const rows = []
  if (!table) {
    for (const r of db.prepare('SELECT id, at, kind, actor, text, pin_id FROM project_event ORDER BY id DESC LIMIT ?').all(lim)) {
      rows.push({ scope: 'project', table: null, id: r.id, at: r.at, kind: r.kind, actor: r.actor, text: r.text, pinId: r.pin_id })
    }
  }
  const where = []
  const params = []
  tableFilter(where, params, table)
  if (kind) { where.push('kind = ?'); params.push(String(kind)) }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  for (const r of db.prepare(`SELECT id, table_id, at, kind, actor, text, pin_id FROM table_event ${filter} ORDER BY id DESC LIMIT ?`).all(...params, lim)) {
    rows.push({ scope: 'table', table: r.table_id, id: r.id, at: r.at, kind: r.kind, actor: r.actor, text: r.text, pinId: r.pin_id })
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, lim)
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

export const QUERY_KINDS = ['counts', 'pending', 'cells', 'votes', 'submissions', 'runs', 'meta', 'events', 'schema']

export function runQuery(db, { what, ...filters }) {
  switch (what) {
    case 'counts': return queryCounts(db, filters)
    case 'pending': return queryPending(db, filters)
    case 'cells': return queryCells(db, filters)
    case 'votes': return queryVotes(db, filters)
    case 'submissions': return querySubmissions(db, filters)
    case 'runs': return queryRuns(db, filters)
    case 'meta': return queryMeta(db, filters)
    case 'events': return queryEvents(db, filters)
    case 'schema': return querySchema(db, filters)
    default: throw new Error(`未知的查询类型：${what}（可用：${QUERY_KINDS.join(', ')}）`)
  }
}
