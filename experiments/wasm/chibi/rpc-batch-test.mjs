import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [join(here, 'rpc-server.mjs')], {
  cwd: here,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })
child.stdin.end([
  { id: 'c1', op: 'capabilities' },
  {
    id: 'r1',
    op: 'load-module',
    source: '(register-rule! "counter" "1" (let ((n 0)) (lambda (x) (set! n (+ n 1)) n)))',
    calls: [{ rule: 'counter', args: [0] }],
  },
  {
    id: 'r2',
    op: 'load-module',
    source: '',
    calls: [{ rule: 'counter', args: [0] }],
  },
  {
    id: 'r3',
    op: 'load-module',
    source: '(register-rule! "counter" "1" (lambda (x) x))',
    calls: [],
  },
  {
    id: 'r4',
    op: 'load-module',
    source: '',
    calls: [{ rule: 'counter', args: [0] }],
  },
].map((request) => JSON.stringify(request)).join('\n') + '\n')
child.on('close', (code) => {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  console.log(JSON.stringify({ code, lines, stderr: stderr.trim() }, null, 2))
})
