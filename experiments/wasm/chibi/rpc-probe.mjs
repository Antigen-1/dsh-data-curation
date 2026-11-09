import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [join(here, 'rpc-server.mjs')], {
  cwd: here,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
const start = Date.now()
child.stdout.on('data', (chunk) => console.log(`[${Date.now() - start}ms] stdout`, chunk.toString().trim()))
child.stderr.on('data', (chunk) => console.log(`[${Date.now() - start}ms] stderr`, chunk.toString().trim()))
child.on('exit', (code) => console.log(`[${Date.now() - start}ms] exit`, code))
child.stdin.write('{"id":"c1","op":"capabilities"}\n')
setTimeout(() => {
  console.log(`[${Date.now() - start}ms] closing stdin`)
  child.stdin.end()
}, 2000)
setTimeout(() => {
  if (!child.killed) child.kill()
  process.exit(0)
}, 5000)
