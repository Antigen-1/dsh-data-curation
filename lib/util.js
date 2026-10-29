// lib/util.js — filesystem, hashing and CSV helpers. No third-party imports.
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export const nowIso = () => new Date().toISOString()
export const newRunId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

export const toPosix = (p) => String(p).split(sep).join('/')

/** Resolve `p` inside `root`; throws when the result escapes the root. */
export function resolveInside(root, p) {
  const abs = resolve(root, p)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径越界：${p}`)
  return abs
}

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

export async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'))
}

export async function readJsonOr(p, fallback) {
  try {
    return await readJson(p)
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback
    throw e
  }
}

/** Write text through a same-directory temp file, fsync, then rename. */
export async function atomicWrite(p, text) {
  const dir = dirname(p)
  await ensureDir(dir)
  const tmp = join(dir, `.${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.tmp`)
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, p)
}

export async function writeJson(p, obj) {
  await atomicWrite(p, JSON.stringify(obj, null, 2) + '\n')
}

export async function appendJsonl(p, rows) {
  if (!rows.length) return
  await ensureDir(dirname(p))
  await fs.appendFile(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

export async function readJsonl(p) {
  let text
  try {
    text = await fs.readFile(p, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      throw new Error(`JSONL 行无法解析（${p}）：${t.slice(0, 80)}`)
    }
  }
  return out
}

/** All regular files under root, as sorted posix-style relative paths. */
export async function walkFiles(root) {
  const out = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) await walk(abs)
      else if (ent.isFile()) out.push(toPosix(relative(root, abs)))
    }
  }
  await walk(root)
  return out.sort()
}

export async function hashFile(p) {
  const buf = await fs.readFile(p)
  return sha256(buf)
}

export async function fileMeta(p) {
  const st = await fs.stat(p)
  return { size: st.size, mtimeMs: st.mtimeMs }
}

/** RFC 4180 CSV -> string[][] (no trailing empty row for a final newline). */
export function csvParse(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const src = text.replace(/^\uFEFF/, '')
  while (i < src.length) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\r' && src[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue }
    if (ch === '\n' || ch === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += ch; i++
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

export function csvEscape(v) {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function csvStringify(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n'
}

export function rowsToObjects(rows, header) {
  return rows.map((r) => {
    const o = {}
    header.forEach((h, idx) => { o[h] = r[idx] ?? '' })
    return o
  })
}

export function objectsToRows(header, objects) {
  return objects.map((o) => header.map((h) => (o[h] === undefined || o[h] === null ? '' : String(o[h]))))
}
