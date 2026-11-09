import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME = join(HERE, '10.4.1')

function runScheme (program) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['run.cjs', '-q'], {
      cwd: RUNTIME,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`chez exited ${code}: ${stderr.slice(-1000)}`))
        return
      }
      resolve(stdout)
    })
    child.stdin.end(program)
  })
}

function parseLines (stdout) {
  const values = new Map()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(.*)$/)
    if (match) values.set(match[1], match[2].trim())
  }
  return values
}

function unquote (value) {
  if (value === undefined) return undefined
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  return value
}

const sourceTree = await readFile(join(HERE, 'source-tree.scm'), 'utf8')
const tests = await readFile(join(HERE, 'test-tree-and-plugins.scm'), 'utf8')
const stdout = await runScheme(`${sourceTree}\n${tests}\n`)
const values = parseLines(stdout)
const failures = []

function expect (label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

for (const key of [
  'tree.space.equal',
  'tree.quote.equal',
  'tree.number.equal',
  'tree.string.equal',
  'tree.changed.diff',
  'tree.symbol-string.diff',
  'tree.order.diff',
]) expect(key, values.get(key), '#t')

const canonicalHex = unquote(values.get('base.canonical.hex'))
const schemeTreeHash = unquote(values.get('base.tree'))
const hostTreeHash = createHash('sha256')
  .update(Buffer.concat([
    Buffer.from('dsh/rule-tree/v1\0', 'utf8'),
    Buffer.from(canonicalHex, 'hex'),
  ]))
  .digest('hex')
expect('host-canonical-hash', hostTreeHash, schemeTreeHash)
expect('plugin.call', values.get('plugin.call'), '42')
expect('rule.call', values.get('rule.call'), '42')
expect('plugin.count', values.get('plugin.count'), '1')
expect('rule.count', values.get('rule.count'), '1')
expect('rule.hash.nonempty', values.get('rule.hash.nonempty'), '64')

const report = {
  ok: failures.length === 0,
  engine: 'Chez Scheme 10.4.1 pb-wasm',
  sourceTreeFormat: 'dsh-rule-tree-v1',
  baseTreeHash: schemeTreeHash,
  canonicalHex,
  hostVerified: hostTreeHash === schemeTreeHash,
  checks: Object.fromEntries(values),
  failures,
}
const outDir = join(HERE, '..', 'results', 'chez', '10.4.1')
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'source-tree-plugin.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1
