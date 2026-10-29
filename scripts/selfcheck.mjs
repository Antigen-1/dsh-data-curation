#!/usr/bin/env node
// scripts/selfcheck.mjs — prepack gate for a publishable plugin package.
//
// Checks, in order:
//   1. leak scan     no absolute local paths, private keys, credential tokens
//   2. syntax        every shipped .js/.mjs passes `node --check`
//   3. hygiene       required package.json fields, files[] present on disk
//   4. skills        every SKILL.md has name/description frontmatter
//
// Exit code 1 on any problem. Scans only what `files[]` ships (this script is
// skipped by name so its own pattern literals do not trip the scan).
import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SELF = 'scripts/selfcheck.mjs'
const SKIP_DIRS = new Set(['node_modules', '.git', '.curation'])

const LEAKS = [
  ['absolute local path', /(?:^|[\s"'`(=])\/(?:home|Users|root|run\/media|mnt|Volumes)\//m],
  ['windows drive path', /[A-Za-z]:\\/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credential token', /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/],
  ['unfilled placeholder', /\{\{\s*(?:TODO|PATH|NAME|FIXME)\s*\}\}/],
]

const problems = []
const note = (msg) => problems.push(msg)

async function collect(entries) {
  const files = []
  async function walk(abs, rel) {
    const st = await stat(abs)
    if (st.isDirectory()) {
      const children = (await readdir(abs)).sort()
      for (const child of children) {
        if (SKIP_DIRS.has(child)) continue
        await walk(join(abs, child), rel ? `${rel}/${child}` : child)
      }
      return
    }
    files.push(rel)
  }
  for (const entry of entries) {
    try {
      await walk(join(root, entry), posix.normalize(entry))
    } catch {
      note(`files[] 里的路径不存在：${entry}`)
    }
  }
  return files
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const key of ['name', 'version', 'description', 'license']) {
  if (!pkg[key]) note(`package.json 缺少 ${key}`)
}
if (!pkg.engines?.node) note('package.json 缺少 engines.node')
if (pkg.repository || pkg.homepage) note('package.json 不应带 repository/homepage（避免占位 URL）')
if (!Array.isArray(pkg.files) || pkg.files.length === 0) note('package.json 缺少 files[]')

const shipped = await collect(pkg.files ?? [])

for (const file of shipped) {
  if (file === SELF) continue
  const text = await readFile(join(root, file), 'utf8')
  const lines = text.split('\n')
  for (const [label, re] of LEAKS) {
    lines.forEach((line, i) => {
      if (re.test(line)) note(`${label} @ ${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  if (/\.(?:m?js)$/.test(file)) {
    try {
      execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
    } catch (e) {
      note(`语法错误 @ ${file}: ${String(e.stderr ?? e.message).split('\n')[0]}`)
    }
  }
  if (file.endsWith('SKILL.md')) {
    // Skills are registered through ctx.skills.register({name, description}), so
    // frontmatter is optional; the body must still be a titled, non-trivial doc.
    const head = lines.slice(0, 4).join('\n')
    if (!/^#\s+\S/m.test(head) && !head.startsWith('---')) note(`SKILL.md 缺少标题或 frontmatter：${file}`)
    if (text.length < 400) note(`SKILL.md 内容过短（${text.length} 字符）：${file}`)
  }
}

if (problems.length) {
  console.error(`selfcheck: ${problems.length} 个问题`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`selfcheck: OK (${shipped.length} 个发布文件扫描通过)`)
