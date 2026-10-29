// lib/manifest.js — read-only baseline of the source material.
//
// The manifest is the immutable-source gate: once it is written, any change to
// the listed source files (content, size, path set) fails the gate and blocks
// every write path until a human explains it.
import { promises as fs } from 'node:fs'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { hashFile, nowIso, resolveInside, sha256, toPosix, walkFiles } from './util.js'

async function collectFiles(root, sources) {
  const found = new Map()
  for (const src of sources) {
    if (typeof src !== 'string' || !src) throw new Error('source 必须是非空字符串')
    if (isAbsolute(src)) throw new Error(`source 必须是项目内相对路径：${src}`)
    const abs = resolveInside(root, src)
    const st = await fs.stat(abs)
    if (st.isDirectory()) {
      for (const rel of await walkFiles(abs)) found.set(toPosix(join(src, rel)), join(abs, rel))
    } else if (st.isFile()) {
      found.set(toPosix(relative(root, abs)), abs)
    } else {
      throw new Error(`source 既不是文件也不是目录：${src}`)
    }
  }
  return found
}

/** @returns {Promise<{createdAt:string,sources:string[],entries:Array<{path,size,mtimeMs,sha256}>}>} */
export async function buildManifest(root, sources) {
  const files = await collectFiles(root, sources)
  const entries = []
  for (const [rel, abs] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const st = await fs.stat(abs)
    entries.push({ path: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: await hashFile(abs) })
  }
  return { createdAt: nowIso(), sources: [...sources], entries, sha256: manifestHash(entries) }
}

export const manifestHash = (entries) => sha256(JSON.stringify(entries))

/** Recompute and diff. Anything other than an identical entry list is drift. */
export async function verifyManifest(root, manifest) {
  const current = await buildManifest(root, manifest.sources)
  const before = new Map(manifest.entries.map((e) => [e.path, e]))
  const after = new Map(current.entries.map((e) => [e.path, e]))
  const missing = []
  const added = []
  const changed = []
  for (const [p, e] of before) {
    const now = after.get(p)
    if (!now) missing.push(p)
    else if (now.sha256 !== e.sha256 || now.size !== e.size) changed.push(p)
  }
  for (const p of after.keys()) if (!before.has(p)) added.push(p)
  return {
    ok: missing.length === 0 && added.length === 0 && changed.length === 0,
    missing,
    added,
    changed,
    checked: before.size,
    expectedHash: manifest.sha256,
    currentHash: current.sha256,
  }
}
