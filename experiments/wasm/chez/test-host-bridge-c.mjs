import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')
const CAP = 1 << 20
const MASK = CAP - 1
const control = new SharedArrayBuffer(8 * 4)
const input = new SharedArrayBuffer(CAP)
const output = new SharedArrayBuffer(CAP)
const ctrl = new Int32Array(control)
const inBuf = new Uint8Array(input)
const outBuf = new Uint8Array(output)
const IN_POS = 0
const IN_READ = 1
const OUT_POS = 2
const OUT_READ = 3
const SHUTDOWN = 4

let inPos = 0
let outRead = 0
let buffered = Buffer.alloc(0)
let workerError = null
let workerExit = null

const worker = new Worker(new URL('./host-bridge-c-worker.cjs', import.meta.url), {
  workerData: { control, input, output },
})

worker.on('message', (message) => {
  if (message.type === 'error') workerError = message
  else if (message.type === 'exit') workerExit = message
})
worker.on('error', (error) => { workerError = { message: error.stack ?? String(error) } })
worker.on('exit', (code) => { workerExit = { code } })

function sendBytes (bytes) {
  const end = Atomics.load(ctrl, IN_POS)
  const read = Atomics.load(ctrl, IN_READ)
  if (end - read + bytes.length > CAP) throw new Error('input ring full')
  for (let i = 0; i < bytes.length; i++) {
    inBuf[(end + i) & MASK] = bytes[i]
    Atomics.store(ctrl, IN_POS, ++inPos)
  }
  Atomics.notify(ctrl, IN_POS)
}

function drain () {
  const end = Atomics.load(ctrl, OUT_POS)
  if (end <= outRead) return
  const chunk = Buffer.alloc(end - outRead)
  for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
  outRead = end
  Atomics.store(ctrl, OUT_READ, outRead)
  Atomics.notify(ctrl, OUT_READ)
  buffered = Buffer.concat([buffered, chunk])
}

async function waitForLine (timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    drain()
    const at = buffered.indexOf(0x0a)
    if (at >= 0) {
      const line = buffered.subarray(0, at).toString('utf8')
      buffered = buffered.subarray(at + 1)
      return line
    }
    if (workerError) throw new Error(workerError.message)
    if (workerExit && workerExit.code !== undefined) {
      throw new Error(`worker exited: ${JSON.stringify(workerExit)}`)
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for output line')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function sendRequest (payload) {
  return new Promise((resolve, reject) => {
    const id = 1
    const timer = setTimeout(() => reject(new Error('dispatch timeout')), 10000)
    const onMessage = (message) => {
      if (message.id !== id) return
      clearTimeout(timer)
      worker.off('message', onMessage)
      if (message.type === 'response') resolve(message.text)
      else reject(new Error(message.message || 'worker error'))
    }
    worker.on('message', onMessage)
    worker.postMessage({ type: 'dispatch', id, payload })
  })
}

async function main () {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('load timeout')), 15000)
    worker.on('message', (message) => {
      if (message.type === 'loaded') {
        clearTimeout(timer)
        resolve()
      } else if (message.type === 'error') {
        clearTimeout(timer)
        reject(new Error(message.message))
      }
    })
  })

  const started = Date.now()
  const dispatchPromise = sendRequest('ping')
  const requestLine = await waitForLine(15000)
  if (requestLine !== 'ping') throw new Error(`unexpected request line: ${requestLine}`)

  const responseAt = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 30))
  sendBytes(Buffer.from('pong:ping\n', 'utf8'))
  const text = await dispatchPromise
  const elapsedMs = Date.now() - responseAt
  const ok = text === 'pong:ping' && elapsedMs >= 20
  const result = {
    ok,
    checkedAt: new Date().toISOString(),
    request: 'ping',
    response: text,
    elapsedMs,
    totalElapsedMs: Date.now() - started,
    transport: 'C ABI dsh_dispatch + blocking stdin/stdout device; no continuation capture',
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'host-bridge.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  Atomics.store(ctrl, SHUTDOWN, 1)
  Atomics.notify(ctrl, IN_POS)
  await worker.terminate()
  if (!ok) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error.stack ?? String(error))
  console.error(JSON.stringify({ workerError, workerExit, buffered: buffered.toString('utf8') }, null, 2))
  Atomics.store(ctrl, SHUTDOWN, 1)
  Atomics.notify(ctrl, IN_POS)
  await worker.terminate()
  process.exitCode = 1
}
