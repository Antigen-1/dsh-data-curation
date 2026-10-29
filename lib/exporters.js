// lib/exporters.js — the exporter registry.
//
// The curated table inside the workspace SQLite is the only authoritative
// output; everything else is a rebuildable artifact. Exports therefore are
// pluggable in two ways:
//
//   1. code:  registerExporter({ name, extension?, description?, run })
//             run({ table, key, columns, rows, out, cwd, fields }) => { rows, columns }
//   2. contract: exporters: { "my-format": { command, args? } }
//      The command runs in the project root through the shell, receives the
//      payload as JSON on stdin and must write its output file to the path in
//      $CURATION_EXPORT_OUT.
//
// Built-in formats use names the contract may not override.
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { csvStringify, objectsToRows } from './util.js'
import { openDb, quoteIdent, withTransaction } from './db.js'

const registry = new Map()

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

const colType = (field) => (field?.type === 'number' ? 'REAL' : 'TEXT')

/** Register (or replace) an exporter. Throws on a malformed definition. */
export function registerExporter(def) {
  const { name, run } = def ?? {}
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`导出器名称不合法：${String(name)}（字母开头，字母数字_-，最长 32）`)
  }
  if (typeof run !== 'function') throw new Error(`导出器 ${name} 缺少 run() 函数`)
  registry.set(name, {
    name,
    kind: 'registered',
    description: def.description ?? '',
    extension: typeof def.extension === 'string' && def.extension ? def.extension : name,
    run,
  })
  return name
}

/** Remove an exporter (mainly for tests and hot reloads). Built-ins may be replaced. */
export function unregisterExporter(name) {
  return registry.delete(name)
}

export function backendNames() {
  return [...registry.keys()]
}

export function listExporters() {
  return [...registry.values()].map(({ name, kind, description, extension }) => ({ name, kind, description, extension }))
}

const markdownCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')

async function ensureParent(file) {
  await fs.mkdir(dirname(file), { recursive: true })
}

registerExporter({
  name: 'csv',
  extension: 'csv',
  description: 'RFC 4180 CSV（带表头，UTF-8）',
  async run({ columns, rows, out }) {
    await ensureParent(out)
    await fs.writeFile(out, csvStringify([columns, ...objectsToRows(columns, rows)]), 'utf8')
    return { rows: rows.length, columns: columns.length }
  },
})

registerExporter({
  name: 'jsonl',
  extension: 'jsonl',
  description: '每行一个 JSON 对象',
  async run({ columns, rows, out }) {
    await ensureParent(out)
    await fs.writeFile(out, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    return { rows: rows.length, columns: columns.length }
  },
})

registerExporter({
  name: 'markdown',
  extension: 'md',
  description: 'Markdown 表格（供报告与评审）',
  async run({ columns, rows, out }) {
    await ensureParent(out)
    const lines = [
      `| ${columns.map(markdownCell).join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => `| ${columns.map((c) => markdownCell(r[c])).join(' | ')} |`),
    ]
    await fs.writeFile(out, `${lines.join('\n')}\n`, 'utf8')
    return { rows: rows.length, columns: columns.length }
  },
})

registerExporter({
  name: 'sqlite',
  extension: 'sqlite',
  description: '独立 SQLite 快照（只含 curated 表）',
  async run({ table, key, columns, rows, out, fields = [] }) {
    await ensureParent(out)
    const tmp = `${out}.tmp-${process.pid}-${Date.now()}`
    await fs.rm(tmp, { force: true })
    const fieldByName = new Map(fields.map((f) => [f.name, f]))
    const db = openDb(tmp)
    try {
      const cols = columns.map((c) => (c === key
        ? `${quoteIdent(c)} TEXT PRIMARY KEY`
        : `${quoteIdent(c)} ${colType(fieldByName.get(c))}`))
      db.exec(`CREATE TABLE ${quoteIdent(table)} (${cols.join(', ')})`)
      withTransaction(db, () => {
        const stmt = db.prepare(`INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        for (const row of rows) stmt.run(...columns.map((c) => (row[c] === '' || row[c] === undefined ? null : row[c])))
      })
    } finally {
      db.close()
    }
    await fs.rename(tmp, out)
    return { rows: rows.length, columns: columns.length }
  },
})

/** Turn a contract `exporters` entry into an exporter definition. */
export function externalExporter(name, spec) {
  return {
    name,
    kind: 'external',
    description: spec.command,
    extension: name,
    async run({ cwd, table, key, columns, rows, out }) {
      await ensureParent(out)
      const payload = JSON.stringify({ table, key, columns, rows })
      const env = {
        ...process.env,
        CURATION_EXPORT_FORMAT: name,
        CURATION_EXPORT_TABLE: table,
        CURATION_EXPORT_KEY: key,
        CURATION_EXPORT_OUT: out,
      }
      const r = spawnSync(spec.command, spec.args ?? [], {
        cwd,
        shell: true,
        input: payload,
        env,
        encoding: 'utf8',
        timeout: 5 * 60 * 1000,
        maxBuffer: 8 << 20,
      })
      if (r.error) throw new Error(`外部导出器 ${name} 无法执行：${r.error.message}`)
      if (r.status !== 0) {
        throw new Error(`外部导出器 ${name} 退出码 ${r.status ?? 'null'}：${(r.stderr || r.stdout || '').trim().slice(-500)}`)
      }
      try {
        await fs.stat(out)
      } catch {
        throw new Error(`外部导出器 ${name} 没有写出文件（应写入 $CURATION_EXPORT_OUT）`)
      }
      return { rows: rows.length, columns: columns.length }
    },
  }
}

/** Resolve a format name: registered exporters win, then project-defined ones. */
export function resolveExporter(name, external = {}) {
  if (registry.has(name)) return registry.get(name)
  const spec = external?.[name]
  if (spec) return externalExporter(name, { command: spec.command, args: spec.args ?? [] })
  const available = [...registry.keys(), ...Object.keys(external ?? {})].sort()
  throw new Error(`未注册的导出格式：${name}（可用：${available.join(', ')}）`)
}

/** Run one exporter against a curated table snapshot. */
export async function runExporter(name, ctx) {
  const exporter = resolveExporter(name, ctx.external)
  const result = await exporter.run(ctx)
  return { format: name, extension: exporter.extension, kind: exporter.kind, ...(result ?? {}) }
}
