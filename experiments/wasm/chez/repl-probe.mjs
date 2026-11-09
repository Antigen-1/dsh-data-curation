import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [join(here, '10.4.1', 'run.cjs'), '-q'], {
  cwd: join(here, '10.4.1'),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
const start = Date.now()
child.stdout.on('data', (chunk) => console.log(`[${Date.now() - start}ms] stdout`, JSON.stringify(chunk.toString())))
child.stderr.on('data', (chunk) => console.log(`[${Date.now() - start}ms] stderr`, JSON.stringify(chunk.toString())))
child.on('exit', (code) => console.log(`[${Date.now() - start}ms] exit`, code))
child.stdin.write('(display "hi") (newline) (flush-output-port (current-output-port)) (display "early-err" (current-error-port)) (flush-output-port (current-error-port))\n')
setTimeout(() => {
  console.log(`[${Date.now() - start}ms] second request`)
  child.stdin.write('(display "there") (newline) (flush-output-port (current-output-port))\n')
}, 1000)
setTimeout(() => {
  console.log(`[${Date.now() - start}ms] closing stdin`)
  child.stdin.end()
}, 3000)
setTimeout(() => {
  if (!child.killed) child.kill()
  process.exit(0)
}, 5000)
