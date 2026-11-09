import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Negative test: a stdin-pipe Chibi VM must not be mistaken for a line-interactive
// RPC server. It currently responds only after the host closes stdin.
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

child.stdin.write('{"id":"c1","op":"capabilities"}\n')
await new Promise((resolve) => setTimeout(resolve, 600))
assert.equal(stdout.trim(), '', `unexpected line-interactive response: ${stdout}`)
console.log('before-eof', JSON.stringify({ bytes: stdout.length }))

child.stdin.end()
await new Promise((resolve) => child.on('close', resolve))
const lines = stdout.split(/\r?\n/).filter(Boolean)
assert.equal(lines.length, 1)
assert.equal(JSON.parse(lines[0]).ok, true)
assert.match(stderr, /EXIT_RUNTIME/)
console.log('after-eof', JSON.stringify({ responses: lines.length, ok: JSON.parse(lines[0]).ok }))
console.log('RESULT PASS: batch-only, not line-interactive')
