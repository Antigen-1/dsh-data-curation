import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME = join(HERE, '10.4.1')
const probe = await readFile(join(HERE, 'probe-namespace.scm'), 'utf8')

const child = spawn(process.execPath, ['run.cjs', '-q'], {
  cwd: RUNTIME,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
child.stdin.end(probe)
const code = await new Promise((resolve) => child.on('close', resolve))
const values = new Map()
for (const line of stdout.split(/\r?\n/)) {
  const match = line.match(/^(\S+)\s+(.*)$/)
  if (match) values.set(match[1], match[2].trim())
}
const failures = []
const expect = (label, predicate, message) => {
  if (!predicate) failures.push(`${label}: ${message}`)
}
expect('exit', code === 0, `chez exited ${code}: ${stderr.slice(-500)}`)
expect('only-eval', values.get('only-eval') === '3', 'restricted environment cannot evaluate +')
expect('only-file', (values.get('only-file') ?? '').includes('unbound'), 'restricted environment exposes file ports')
expect('only-import', (values.get('only-import') ?? '').includes('unbound'), 'restricted environment can import chezscheme')
const report = {
  ok: failures.length === 0,
  probe: 'only (rnrs) + - * = display',
  observed: Object.fromEntries(values),
  failures,
}
const outDir = join(HERE, '..', 'results', 'chez', '10.4.1')
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'namespace.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1
