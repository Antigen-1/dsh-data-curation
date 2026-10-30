// lib/pack.js — package a project into one portable archive.
//
// A project is (read-only sources) + (one workspace SQLite). To hand it to
// another machine or archive it, we bundle:
//
//   pack.json          manifest: format version, pin hash, file digests
//   project.sqlite     consistent snapshot of the workspace (VACUUM INTO)
//   pin.json           the stored aggregate pin, rendered for human review
//   exporters.json     registered external exporters
//   manifest.json      the source baseline
//   pending.json       unresolved cells (when present)
//   <referenced files> external scripts named by exporters / verifyCmd
//
// The source materials themselves are NOT copied (they are read-only inputs and
// may be large); the pack records their baseline so drift stays detectable.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { isSafeRelPath } from './contract.js'
import { createZip } from './zip.js'
import { ensureDir, nowIso, toPosix } from './util.js'

export const PACK_FORMAT = 'dsh-data-curation-pack/1'

const MAX_REFERENCED_BYTES = 10 << 20

/** Split a shell command into words, honouring single and double quotes. */
export function tokenizeCommand(command) {
  const tokens = []
  let current = ''
  let quote = null
  for (const ch of String(command ?? '')) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

const isFlag = (t) => t.startsWith('-') || ['>', '<', '|', '&&', '||', ';'].includes(t)

/** Candidate project-relative files referenced by a command line. */
export function referencedPaths(command, root) {
  const found = new Set()
  for (const token of tokenizeCommand(command)) {
    if (!token || isFlag(token)) continue
    if (!isSafeRelPath(token)) continue
    if (!/[/\\.]/.test(token)) continue
    found.add(token)
  }
  return [...found].sort().map((rel) => join(root, rel))
}

/**
 * Build a pack archive.
 * @param {object} store createStore() result
 * @param {{out?:string, label?:string}} [options]
 */
export async function buildPack(store, { out = null, label = null } = {}) {
  const stamp = nowIso().replace(/[:.]/g, '-')
  await ensureDir(store.packsDir)
  const target = out ?? join(store.packsDir, `${stamp}.zip`)

  const snapshot = join(store.dir, `.pack-${process.pid}-${Date.now()}.sqlite`)
  const warnings = []
  const files = []

  const addFile = (name, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    files.push({ name, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) })
    return { name, data: buf }
  }

  try {
    await store.snapshot(snapshot)
    const sqlite = await fs.readFile(snapshot)

    const record = await store.readPinRecord()
    const manifest = await store.readManifest()
    const exporters = await store.listExporters()
    const tables = await store.listTables()
    const pending = await store.readPending()

    const entries = []
    entries.push(addFile('project.sqlite', sqlite))
    if (record?.pin) entries.push(addFile('pin.json', `${JSON.stringify(record.pin, null, 2)}\n`))
    if (exporters.length) entries.push(addFile('exporters.json', `${JSON.stringify(exporters, null, 2)}\n`))
    if (manifest) entries.push(addFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`))
    if (pending?.items?.length) entries.push(addFile('pending.json', `${JSON.stringify(pending, null, 2)}\n`))

    const referenced = new Set()
    for (const t of tables) {
      const cfg = t.config ?? {}
      const cmds = [
        cfg.gates?.verifyCmd,
        cfg.adjudication?.compare?.command,
        cfg.adjudication?.select?.command,
      ]
      for (const spec of cmds) {
        if (!spec) continue
        for (const abs of referencedPaths(spec, store.cwd)) referenced.add(abs)
        for (const arg of spec.args ?? []) {
          if (!isSafeRelPath(arg)) continue
          for (const abs of referencedPaths(arg, store.cwd)) referenced.add(abs)
        }
      }
    }
    for (const ex of exporters) for (const abs of referencedPaths(ex.command, store.cwd)) referenced.add(abs)
    for (const ex of exporters) for (const arg of ex.args ?? []) {
      if (!isSafeRelPath(arg)) continue
      for (const abs of referencedPaths(arg, store.cwd)) referenced.add(abs)
    }
    for (const abs of [...referenced].sort()) {
      // relPath keeps paths correct even when cwd itself is a symlink.
      const rel = toPosix(relative(store.cwd, abs))
      try {
        const stat = await fs.lstat(abs)
        // A symlink inside the project may point anywhere on the machine;
        // packing it would leak the target's bytes into a shareable archive.
        if (stat.isSymbolicLink()) {
          warnings.push(`引用文件是符号链接，已跳过：${rel}`)
          continue
        }
        if (!stat.isFile()) continue
        if (stat.size > MAX_REFERENCED_BYTES) {
          warnings.push(`跳过大文件 ${rel}（${stat.size} 字节）`)
          continue
        }
        entries.push(addFile(`referenced/${rel}`, await fs.readFile(abs)))
      } catch (e) {
        warnings.push(`引用文件不可读：${rel}（${e.code ?? e.message}）`)
      }
    }

    const meta = {
      format: PACK_FORMAT,
      createdAt: nowIso(),
      label: label ?? null,
      pinHash: record?.hash ?? null,
      sourceManifestSha: manifest?.sha256 ?? null,
      workspace: 'project.sqlite',
      files: entries.map((e) => files.find((f) => f.name === e.name)),
      warnings,
    }
    entries.unshift({ name: 'pack.json', data: `${JSON.stringify(meta, null, 2)}\n` })

    const zip = createZip(entries)
    await ensureDir(dirname(target))
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, zip)
    await fs.rename(tmp, target)

    return {
      ok: true,
      path: toPosix(target),
      bytes: zip.length,
      files: meta.files,
      pinHash: meta.pinHash,
      sourceManifestSha: meta.sourceManifestSha,
      warnings,
    }
  } finally {
    await fs.rm(snapshot, { force: true }).catch(() => {})
  }
}

