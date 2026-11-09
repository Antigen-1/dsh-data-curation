import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const scriptFile = process.argv[2]
const extraFiles = process.argv.slice(3)
if (!scriptFile) {
  console.error('usage: node test-script-output.mjs <script.scm> [extra.scm ...]')
  process.exit(2)
}

const CAP = 1 << 20
const MASK = CAP - 1
const control = new SharedArrayBuffer(8 * 4)
const input = new SharedArrayBuffer(CAP)
const output = new SharedArrayBuffer(CAP)
const ctrl = new Int32Array(control)
const outBuf = new Uint8Array(output)
const OUT_POS = 2
const OUT_READ = 3

let outRead = 0
const chunks = []
let stderrText = ''
let exit = null
let failure = null

function drain () {
  const end = Atomics.load(ctrl, OUT_POS)
  if (end <= outRead) return
  const chunk = Buffer.alloc(end - outRead)
  for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
  outRead = end
  Atomics.store(ctrl, OUT_READ, outRead)
  Atomics.notify(ctrl, OUT_READ)
  chunks.push(chunk)
}

const worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
  workerData: { control, input, output, scriptFile, extraFiles },
})
worker.on('message', (message) => {
  if (message.type === 'exit') {
    exit = message
    stderrText = message.stderr || ''
  } else if (message.type === 'error') {
    failure = message
    stderrText = message.stderr || ''
  }
})
worker.on('error', (error) => {
  failure = { message: error.stack ?? String(error) }
})

const deadline = Date.now() + 30000
while (exit === null && failure === null && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
drain()
await worker.terminate()

if (failure) {
  console.error(JSON.stringify(failure, null, 2))
  process.exitCode = 1
} else if (exit === null) {
  console.error('timed out waiting for script exit')
  process.exitCode = 1
} else {
  const stdout = Buffer.concat(chunks).toString('utf8')
  process.stdout.write(stdout)
  if (stderrText) process.stderr.write(stderrText)
  if (exit.code !== 0) process.exitCode = exit.code
}
