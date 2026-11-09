import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createFfiRegistry, FfiError, validateFfiManifest } from './ffi-registry.mjs'
import { FfiBroker } from './ffi-broker.mjs'

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
let loaded = false
let workerError = null

const worker = new Worker(new URL('./host-bridge-c-worker.cjs', import.meta.url), {
  workerData: { control, input, output, guestFile: '/online-vm-c.scm' },
})
worker.on('message', (message) => {
  if (message.type === 'loaded') loaded = true
  if (message.type === 'error') workerError = message
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

async function waitForLine (timeoutMs = 15000) {
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
    if (Date.now() > deadline) throw new Error('timed out waiting for output line')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function dispatch (payload) {
  return new Promise((resolve, reject) => {
    const id = 1
    const timer = setTimeout(() => reject(new Error('dispatch timeout')), 15000)
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

function schemeValue (value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `(list ${value.map(schemeValue).join(' ')})`
  return '#f'
}

async function runFfi (request, broker, timeoutMs = 100) {
  const promise = dispatch(request)
  const line = await waitForLine()
  const fields = line.split('\t')
  if (fields.length !== 2 || fields[0] !== 'DSH-FFI') {
    throw new Error(`bad host frame: ${line}`)
  }
  let frame
  try {
    frame = JSON.parse(fields[1])
  } catch {
    throw new Error(`host frame is not JSON: ${line}`)
  }
  const keys = Object.keys(frame).sort().join(',')
  if (keys !== 'args,id,kind,rid,rule,target') {
    throw new Error(`unexpected host frame keys: ${keys}`)
  }
  if (![frame.id, frame.rid, frame.kind, frame.rule, frame.target].every((value) => typeof value === 'string')) {
    throw new Error('host frame fields must be strings')
  }
  if (!Array.isArray(frame.args)) throw new Error('host frame args must be an array')
  const requestId = randomUUID()
  try {
    const work = broker.invoke({
      requestId,
      ruleHash: frame.rule,
      kind: frame.kind,
      target: frame.target,
      args: frame.args,
    })
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'E-TIMEOUT' })), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    const value = await Promise.race([work, timeout])
    sendBytes(Buffer.from(`(ok ${schemeValue(value)})\n`, 'utf8'))
  } catch (error) {
    sendBytes(Buffer.from(`(error ${JSON.stringify(error.code || 'E-HOST')})\n`, 'utf8'))
  }
  return JSON.parse(await promise)
}

async function main () {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('load timeout')), 15000)
    const poll = setInterval(() => {
      if (loaded) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve()
      }
    }, 5)
    worker.on('message', (message) => {
      if (message.type === 'error') {
        clearTimeout(timer)
        clearInterval(poll)
        reject(new Error(message.message))
      }
    })
  })

  const manifest = validateFfiManifest(JSON.parse(readFileSync(join(HERE, 'ffi-manifest.json'), 'utf8')))
  const ffi = createFfiRegistry({
    manifest,
    handlers: {
      'math.add': ([a, b]) => a + b,
      'math.fail': () => { throw new FfiError('E-FFI-HOST', 'host rejected') },
      'delay.echo': ([value]) => new Promise((resolve) => setTimeout(() => resolve(value), 30)),
      'delay.slow': () => new Promise((resolve) => setTimeout(() => resolve('too-late'), 300)),
    },
  })
  const broker = new FfiBroker({ capabilities: {}, ffi, timeoutMs: 100 })

  const sync = await runFfi('(request "f1" ffi-call "r1" "ffi" "rule-a" "math.add" (1 2))', broker)
  const async = await runFfi('(request "f2" ffi-call "r2" "ffi" "rule-a" "delay.echo" ("hello"))', broker)
  const failure = await runFfi('(request "f3" ffi-call "r3" "ffi" "rule-a" "math.fail" ())', broker)
  const timeout = await runFfi('(request "f4" ffi-call "r4" "ffi" "rule-a" "delay.slow" ())', broker, 100)
  const result = {
    ok: sync.value === 3 && async.value === 'hello' && failure.error?.code === 'E-FFI-HOST' && timeout.error?.code === 'E-TIMEOUT',
    sync,
    async,
    failure,
    timeout,
    checkedAt: new Date().toISOString(),
    transport: 'blocking C ABI stdin/stdout bridge, FfiBroker invocation',
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'blocking-broker.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  Atomics.store(ctrl, SHUTDOWN, 1)
  Atomics.notify(ctrl, IN_POS)
  await worker.terminate()
  if (!result.ok) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error.stack ?? String(error))
  console.error(JSON.stringify({ workerError, buffered: buffered.toString('utf8') }, null, 2))
  Atomics.store(ctrl, SHUTDOWN, 1)
  Atomics.notify(ctrl, IN_POS)
  await worker.terminate()
  process.exitCode = 1
}
