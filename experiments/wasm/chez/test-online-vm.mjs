import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'online-vm.json')
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
let stderrText = ''
let workerError = null
let workerExit = null
let loaded = false

const worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
  workerData: { control, input, output },
})

worker.on('message', (message) => {
  if (message.type === 'loaded') loaded = true
  else if (message.type === 'exit') workerExit = message
  else if (message.type === 'error') workerError = message
})
worker.on('error', (error) => { workerError = { message: error.stack ?? String(error) } })

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

function sendFrame (payload) {
  if (!/^[\x00-\x7f]*$/.test(payload)) throw new Error('protocol payload must be ASCII')
  const body = Buffer.from(payload, 'utf8')
  const frame = Buffer.concat([Buffer.from(`${body.length}\n`, 'ascii'), body, Buffer.from('\n', 'ascii')])
  sendBytes(frame)
  return frame.length
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

async function ensure (condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    drain()
    if (condition()) return
    if (workerError) throw new Error(`worker error: ${workerError.message}`)
    if (workerExit) throw new Error(`worker exited before completion: ${JSON.stringify(workerExit)}`)
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function readLine (timeoutMs = 15000) {
  await ensure(() => buffered.includes(0x0a), timeoutMs, 'timed out waiting for frame header')
  const at = buffered.indexOf(0x0a)
  const line = buffered.subarray(0, at).toString('ascii')
  buffered = buffered.subarray(at + 1)
  return line
}

async function readExact (n, timeoutMs = 15000) {
  await ensure(() => buffered.length >= n, timeoutMs, `timed out waiting for ${n} payload bytes`)
  const bytes = buffered.subarray(0, n)
  buffered = buffered.subarray(n)
  return bytes
}

async function nextFrame (timeoutMs = 15000) {
  const header = await readLine(timeoutMs)
  const length = Number(header)
  if (!Number.isInteger(length) || length < 0 || length > CAP) throw new Error(`bad frame length: ${header}`)
  const payload = await readExact(length, timeoutMs)
  const terminator = await readExact(1, timeoutMs)
  if (terminator[0] !== 0x0a) throw new Error('missing frame terminator')
  return { payload: payload.toString('utf8'), frameBytes: header.length + 1 + length + 1 }
}

async function main () {
  const started = Date.now()
  const ready = await nextFrame()
  if (JSON.parse(ready.payload).ready !== true) throw new Error(`unexpected ready frame: ${ready.payload}`)
  if (!loaded) await ensure(() => loaded, 5000, 'worker did not report loaded')

  const requests = [
    ['r1', '(request "r1" set 42)', 42],
    ['r2', '(request "r2" get)', 42],
    ['r3', '(request "r3" inc 1)', 43],
    ['r4', '(request "r4" get)', 43],
  ]
  const evidence = []
  for (const [id, request, expected] of requests) {
    const sentAt = Date.now()
    const requestFrameBytes = sendFrame(request)
    const frame = await nextFrame()
    const response = JSON.parse(frame.payload)
    if (response.id !== id) throw new Error(`id mismatch: ${frame.payload}`)
    if (response.ok !== true || response.value !== expected) {
      throw new Error(`unexpected response for ${id}: ${frame.payload}`)
    }
    evidence.push({
      requestId: id,
      value: response.value,
      requestFrameBytes,
      responseFrameBytes: frame.frameBytes,
      elapsedMs: Date.now() - sentAt,
    })
  }

  if (new Set(evidence.map((item) => item.requestId)).size !== requests.length) {
    throw new Error('requestId was not unique')
  }

  Atomics.store(ctrl, SHUTDOWN, 1)
  Atomics.notify(ctrl, IN_POS)
  const eof = await nextFrame()
  if (JSON.parse(eof.payload).eof !== true) throw new Error(`unexpected eof frame: ${eof.payload}`)
  await ensure(() => workerExit !== null, 5000, 'worker did not exit after EOF')

  const result = {
    ok: true,
    protocolVersion: 1,
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    assetDir: 'experiments/wasm/chez/10.4.1',
    transport: 'Node Worker + SharedArrayBuffer stdin/stdout device; no PTY, no child process per request',
    frameFormat: '<payload-byte-length>\\n<payload>\\n',
    requests: evidence,
    uniqueRequestIds: true,
    statePreserved: true,
    eofObservedOnlyAfterResponses: true,
    totalElapsedMs: Date.now() - started,
    workerExit,
    stderr: stderrText.slice(-4000),
  }
  mkdirSync(dirname(RESULT), { recursive: true })
  writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  await worker.terminate()
}

try {
  await main()
} catch (error) {
  console.error(error.stack ?? String(error))
  console.error(JSON.stringify({ workerError, workerExit, buffered: buffered.toString('utf8'), stderrText }, null, 2))
  Atomics.store(ctrl, SHUTDOWN, 1)
  Atomics.notify(ctrl, IN_POS)
  await worker.terminate()
  process.exitCode = 1
}
