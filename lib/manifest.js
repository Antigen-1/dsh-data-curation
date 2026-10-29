// lib/manifest.js — read-only baseline of the source material.
//
// The manifest is the immutable-source gate: once it is written, any change to
// the listed source files (content, size, path set) fails the gate and blocks
// every write path until a human explains it.
import { promises as fs } from 'node:fs'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { hashFile, nowIso, resolveInside, sha256, toPosix, walkFiles } from './util.js'

async function collectFiles(root, sources, exclude = []) {
  const excluded = exclude.map((e) => toPosix(e).replace(/\/+$/, '')).filter(Boolean)
  const isExcluded = (rel) => excluded.some((ex) => rel === ex || rel.startsWith(`${ex}/`))
  const found = new Map()
  for (const src of sources) {
    if (typeof src !== 'string' || !src) throw new Error('source 必须是非空字符串')
    if (isAbsolute(src)) throw new Error(`source 必须是项目内相对路径：${src}`)
    const abs = resolveInside(root, src)
    const srcRel = toPosix(relative(root, abs))
    if (srcRel && isExcluded(srcRel)) continue
    const st = await fs.stat(abs)
    if (st.isDirectory()) {
      for (const rel of await walkFiles(abs)) {
        const path = toPosix(join(src, rel))
        if (!isExcluded(path)) found.set(path, join(abs, rel))
      }
    } else if (st.isFile()) {
      const path = toPosix(relative(root, abs))
      if (!isExcluded(path)) found.set(path, abs)
    } else {
      throw new Error(`source 既不是文件也不是目录：${src}`)
    }
  }
  return found
}

/**
 * Build the baseline.
 *
 * `exclude` keeps the project workspace (and any other derived directory) out of
 * the baseline: without it `sources: ['.']` would list `.curation/project.sqlite`
 * and every later workspace write would look like source drift.
 *
 * `reuse` is the previous manifest; an entry whose size AND mtime are unchanged
 * keeps its old sha256 instead of re-reading the file (write paths use this;
 * verification passes no `reuse` so it always re-reads everything).
 *
 * @returns {Promise<{createdAt:string,sources:string[],exclude:string[],entries:Array<{path,size,mtimeMs,sha256}>,sha256:string}>}
 */
export async function buildManifest(root, sources, { exclude = [], reuse = null } = {}) {
  const files = await collectFiles(root, sources, exclude)
  const previous = new Map((reuse?.entries ?? []).map((e) => [e.path, e]))
  const entries = []
  for (const [rel, abs] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const st = await fs.stat(abs)
    const size = st.size
    const mtimeMs = Math.round(st.mtimeMs)
    const prev = previous.get(rel)
    const sha256 = prev && prev.size === size && prev.mtimeMs === mtimeMs && prev.sha256
      ? prev.sha256
      : await hashFile(abs)
    entries.push({ path: rel, size, mtimeMs, sha256 })
  }
  return { createdAt: nowIso(), sources: [...sources], exclude: [...exclude], entries, sha256: manifestHash(entries) }
}

export const manifestHash = (entries) => sha256(JSON.stringify(entries))

/**
 * Recompute and diff. Anything other than an identical entry list is drift.
 *
 * Pass `reuse: manifest` on write paths (unchanged size+mtime keeps the old
 * hash); omit it for verification and packing, which must re-read every byte.
 */
export async function verifyManifest(root, manifest, { reuse = null } = {}) {
  const current = await buildManifest(root, manifest.sources, {
    exclude: manifest.exclude ?? [],
    reuse: reuse ?? null,
  })
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
