import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(HERE, 'source-tree.scm'), 'utf8')
const vectors = await readFile(join(HERE, 'test-hash-vectors.scm'), 'utf8')
const child = spawn(process.execPath, ['run.cjs', '-q'], {
  cwd: join(HERE, '10.4.1'),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
child.stdin.end(`${source}\n${vectors}\n`)
const code = await new Promise((resolve) => child.on('close', resolve))
const values = new Map()
for (const line of stdout.split(/\r?\n/)) {
  const match = line.match(/^(\S+)\s+(.*)$/)
  if (match) values.set(match[1], match[2].trim())
}
const expected = {
  'sha-empty': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'sha-abc': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'sha-long': '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
}
const failures = []
for (const [key, value] of Object.entries(expected)) {
  if (values.get(key) !== value) failures.push(`${key}: expected ${value}, got ${values.get(key)}`)
}
const report = { ok: failures.length === 0 && code === 0, code, expected, observed: Object.fromEntries(values), failures }
const outDir = join(HERE, '..', 'results', 'chez', '10.4.1')
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'sha-vectors.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
