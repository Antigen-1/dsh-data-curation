// lib/delivery.js — the curated table inside the project workspace.
//
// The workspace SQLite file is the only place this plugin writes project data.
// The curated table is derived from accepted decisions:
//
//   * rows are located by key value, never by row number;
//   * a row is created on first write, so the table can start empty;
//   * all cell writes plus the re-read comparison happen in ONE transaction, so
//     a crash leaves either the old table or the new one, never a half table;
//   * re-read comparison uses the contract field type (numbers compare as
//     numbers) and runs before COMMIT.
import { promises as fs } from 'node:fs'
import { csvParse, resolveInside, rowsToObjects } from './util.js'
import { openDb, quoteIdent, tableColumns, tableExists, withTransaction } from './db.js'

const isNumeric = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v))

/** SQLite column type for a contract field type (kept local to avoid cycles). */
const colType = (field) => (field?.type === 'number' ? 'REAL' : 'TEXT')

/** Bind form of a cell: NULL for "explicitly not provided", REAL for numbers. */
function bindCell(field, value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (text === '') return null
  if (field?.type === 'number' && isNumeric(text)) return Number(text)
  return text
}

/** Empty-tolerant comparison between a stored cell and an expected string. */
export function sameCell(field, stored, expected) {
  const a = stored === null || stored === undefined ? '' : String(stored)
  const b = expected === null || expected === undefined ? '' : String(expected)
  if (field?.type === 'number' && a !== '' && b !== '' && isNumeric(a) && isNumeric(b)) {
    return Number(a) === Number(b)
  }
  return a === b
}

function requireTable(delivery) {
  if (typeof delivery?.table !== 'string' || !delivery.table) throw new Error('交付表名无效')
  if (typeof delivery?.key !== 'string' || !delivery.key) throw new Error('交付键列无效')
  return delivery.table
}

/** Create the curated table when missing and add any contract field column it lacks. */
export function ensureCuratedTable(db, delivery, fields) {
  const table = requireTable(delivery)
  if (!tableExists(db, table)) {
    const cols = [
      `${quoteIdent(delivery.key)} TEXT PRIMARY KEY`,
      ...fields.map((f) => `${quoteIdent(f.name)} ${colType(f)}`),
    ]
    db.exec(`CREATE TABLE ${quoteIdent(table)} (${cols.join(', ')})`)
    return { created: true, added: [] }
  }
  const existing = new Set(tableColumns(db, table))
  const added = []
  for (const f of fields) {
    if (existing.has(f.name)) continue
    db.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(f.name)} ${colType(f)}`)
    added.push(f.name)
  }
  return { created: false, added }
}

/** Curated table as {header, rows} where every cell is a string ('' for NULL). */
export function readCurated(db, delivery) {
  const table = requireTable(delivery)
  if (!tableExists(db, table)) throw new Error(`交付表尚未生成：${table}（先运行 curation_apply）`)
  const header = tableColumns(db, table)
  const rows = db.prepare(`SELECT * FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(delivery.key)}`).all().map((r) => {
    const obj = {}
    for (const k of header) obj[k] = r[k] === null || r[k] === undefined ? '' : String(r[k])
    return obj
  })
  return { header, rows }
}

/** Same as readCurated but null when the table does not exist yet. */
export function readCuratedSafe(db, delivery) {
  if (!tableExists(db, requireTable(delivery))) return null
  return readCurated(db, delivery)
}

/** Curated rows keyed by record key. */
export function loadCurated(db, delivery) {
  const table = readCuratedSafe(db, delivery)
  if (!table) return new Map()
  const map = new Map()
  for (const row of table.rows) map.set(String(row[delivery.key]), row)
  return map
}

export function readCell(db, delivery, key, field) {
  const table = requireTable(delivery)
  const row = db.prepare(`SELECT ${quoteIdent(field)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(delivery.key)} = ?`).get(String(key))
  return row ? row.v : undefined
}

/**
 * Write accepted cells into the curated table.
 * Rows are created on demand, so an empty workspace is a valid starting point.
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.db
 * @param {{table:string,key:string}} args.delivery
 * @param {Array<object>} args.fields contract fields
 * @param {Array<{record:string,field:string,value:string}>} args.ops
 * @param {boolean} [args.dryRun]
 */
export function applyCuration({ db, delivery, fields, ops, dryRun = false }) {
  // A dry run must not touch the workspace, not even the schema.
  if (dryRun) {
    const table = requireTable(delivery)
    const exists = tableExists(db, table)
    const existing = exists ? new Set(tableColumns(db, table)) : new Set()
    const addedColumns = fields.filter((f) => !existing.has(f.name)).map((f) => f.name)
    return { ok: true, dryRun: true, applied: ops.length, created: !exists, addedColumns, warnings: [] }
  }
  try {
    return withTransaction(db, () => applyCurationInTx({ db, delivery, fields, ops }))
  } catch (e) {
    if (e?.code === WRITE_FAILED) {
      return { ok: false, errors: e.errors, created: e.created, addedColumns: e.addedColumns }
    }
    throw e
  }
}

export const WRITE_FAILED = 'CURATION_WRITE_FAILED'

/**
 * The body of an apply, without a transaction of its own.
 *
 * Anything wrong after the first UPDATE throws (rolling the caller's
 * transaction back) instead of returning a failure: a half-written curated
 * table with an error message is the worst of both worlds. Callers that want
 * the standalone form use `applyCuration` above.
 */
export function applyCurationInTx({ db, delivery, fields, ops }) {
  const schema = ensureCuratedTable(db, delivery, fields)
  const fail = (problems) => {
    const error = new Error(problems.join('；'))
    error.code = WRITE_FAILED
    error.errors = problems
    error.created = schema.created
    error.addedColumns = schema.added
    throw error
  }
  if (!ops.length) {
    return { ok: true, dryRun: false, applied: 0, created: schema.created, addedColumns: schema.added, warnings: [] }
  }
  const fieldByName = new Map(fields.map((f) => [f.name, f]))
  // The same cell twice in one run: the last op wins, writes stay idempotent.
  const deduped = new Map()
  for (const op of ops) deduped.set(`${op.record}\u0000${op.field}`, op)
  const writes = [...deduped.values()]

  const problems = []
  const insertRow = db.prepare(`INSERT INTO ${quoteIdent(delivery.table)} (${quoteIdent(delivery.key)}) VALUES (?) ON CONFLICT(${quoteIdent(delivery.key)}) DO NOTHING`)
  for (const key of new Set(writes.map((op) => String(op.record)))) insertRow.run(key)

  const stmts = new Map()
  for (const op of writes) {
    let stmt = stmts.get(op.field)
    if (!stmt) {
      stmt = db.prepare(`UPDATE ${quoteIdent(delivery.table)} SET ${quoteIdent(op.field)} = ? WHERE ${quoteIdent(delivery.key)} = ?`)
      stmts.set(op.field, stmt)
    }
    const res = stmt.run(bindCell(fieldByName.get(op.field), op.value), String(op.record))
    if (res.changes !== 1) problems.push(`${op.record}.${op.field}: 更新影响 ${res.changes} 行`)
  }
  if (problems.length) fail(problems)

  for (const op of writes) {
    const stored = readCell(db, delivery, op.record, op.field)
    if (!sameCell(fieldByName.get(op.field), stored, op.value)) {
      problems.push(`${op.record}.${op.field}: 写入后不一致（读到 ${JSON.stringify(stored)}）`)
    }
  }
  if (problems.length) fail(problems)

  return {
    ok: true,
    applied: writes.length,
    created: schema.created,
    addedColumns: schema.added,
    warnings: schema.added.length ? [`交付表新增列：${schema.added.join(', ')}`] : [],
  }
}

/** Resolve the contract's record set into a de-duplicated list of keys. */
export async function resolveRecordIds(root, contract) {
  const rec = contract?.records
  if (!rec) throw new Error('契约缺少 records')
  const dedupe = (keys) => [...new Set(keys.map((k) => String(k)).filter((k) => k !== ''))]
  if (rec.kind === 'list') return dedupe(rec.values ?? [])
  if (rec.kind === 'file') {
    const abs = resolveInside(root, rec.path)
    const text = await fs.readFile(abs, 'utf8')
    let rows
    if (rec.path.endsWith('.jsonl')) {
      rows = []
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          rows.push(JSON.parse(line))
        } catch (e) {
          throw new Error(`记录源第 ${i + 1} 行无法解析：${e.message}`)
        }
      }
    } else {
      const table = csvParse(text)
      const header = table[0] ?? []
      if (!header.includes(rec.key)) throw new Error(`记录源缺少键列：${rec.key}`)
      rows = rowsToObjects(table.slice(1), header)
    }
    const keys = rows.map((r) => r[rec.key]).filter((k) => k !== undefined && k !== null)
    if (!keys.length) throw new Error(`记录源 ${rec.path} 中没有键列 ${rec.key}`)
    return dedupe(keys)
  }
  if (rec.kind === 'db') {
    const abs = resolveInside(root, rec.db)
    const db = openDb(abs, { readOnly: true })
    try {
      if (!tableExists(db, rec.table)) throw new Error(`记录源表不存在：${rec.table}`)
      const rows = db.prepare(`SELECT ${quoteIdent(rec.key)} AS k FROM ${quoteIdent(rec.table)}`).all()
      const keys = rows.map((r) => r.k).filter((k) => k !== undefined && k !== null)
      if (!keys.length) throw new Error(`记录源表 ${rec.table} 中没有键列 ${rec.key}`)
      return dedupe(keys)
    } finally {
      db.close()
    }
  }
  throw new Error(`不支持的 records.kind：${rec.kind}`)
}
