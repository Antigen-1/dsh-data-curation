import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { schemeString } from './pin-v2-lib.mjs'

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
let loaded = false

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

function schemeLiteral (value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  if (Array.isArray(value)) return `(list ${value.map(schemeLiteral).join(' ')})`
  return '#f'
}

async function callHost (request, reply, delayMs) {
  const promise = dispatch(request)
  const line = await waitForLine(15000)
  const fields = line.split('\t')
  if (fields[0] !== 'DSH-FFI' || fields.length !== 2) throw new Error(`unexpected host request: ${line}`)
  let frame
  try {
    frame = JSON.parse(fields[1])
  } catch {
    throw new Error(`host request is not JSON: ${line}`)
  }
  const keys = Object.keys(frame).sort().join(',')
  if (keys !== 'args,id,kind,rid,rule,target') throw new Error(`unexpected host request keys: ${keys}`)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  sendBytes(Buffer.from(`${reply}\n`, 'utf8'))
  return { response: await promise, frame }
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

  const started = Date.now()
  const okCall = await callHost(`(request "f1" ffi-call "rid-1" "capability" "demo" "clock.now" ())`, '(ok 12345)', 30)
  const okResponse = JSON.parse(okCall.response)
  if (okResponse.ok !== true || okResponse.value !== 12345) {
    throw new Error(`unexpected success response: ${okCall.response}`)
  }

  const startedError = Date.now()
  const errorCall = await callHost(`(request "f2" ffi-call "rid-2" "capability" "demo" "clock.now" ())`, '(error "E-TIMEOUT")', 10)
  const errorResponse = JSON.parse(errorCall.response)
  if (errorResponse.ok !== false || errorResponse.error.code !== 'E-TIMEOUT') {
    throw new Error(`unexpected error response: ${errorCall.response}`)
  }

  const injectedRequest = `(request ${schemeString('id\tx')} ffi-call ${schemeString('rid\ny')} "capability" ${schemeString('rule\tz')} "clock.now" ())`
  const injectedCall = await callHost(injectedRequest, '(ok 1)', 0)
  const injected = {
    id: injectedCall.frame.id,
    rid: injectedCall.frame.rid,
    kind: injectedCall.frame.kind,
    rule: injectedCall.frame.rule,
    target: injectedCall.frame.target,
  }
  if (injected.id !== 'id\tx' || injected.rid !== 'rid\ny' || injected.rule !== 'rule\tz') {
    throw new Error(`frame injection changed fields: ${JSON.stringify(injected)}`)
  }

  const oversizedId = 'x'.repeat(70000)
  const oversizedResponse = JSON.parse(await dispatch(
    `(request ${schemeString(oversizedId)} ffi-call "rid-big" "capability" "demo" "clock.now" ())`
  ))
  if (oversizedResponse.ok !== false || oversizedResponse.error.code !== 'E-FFI-FRAME-TOO-LARGE') {
    throw new Error(`oversized frame was not rejected: ${JSON.stringify(oversizedResponse)}`)
  }

  // 40,000 two-byte characters stay below the character cap but exceed the
  // 65,536-byte frame cap once UTF-8 encoded.
  const multibyteId = 'é'.repeat(40000)
  const multibyteResponse = JSON.parse(await dispatch(
    `(request ${schemeString(multibyteId)} ffi-call "rid-utf8" "capability" "demo" "clock.now" ())`
  ))
  if (multibyteResponse.ok !== false || multibyteResponse.error.code !== 'E-FFI-FRAME-TOO-LARGE') {
    throw new Error(`multibyte frame was not rejected: ${JSON.stringify(multibyteResponse)}`)
  }

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    success: { value: okResponse.value, elapsedMs: Date.now() - started },
    error: { code: errorResponse.error.code, elapsedMs: Date.now() - startedError },
    injection: { fields: injected, singleFrame: true },
    frameLimit: {
      code: oversizedResponse.error.code,
      multibyteCode: multibyteResponse.error.code,
      maxBytes: 65536,
      multibyteChars: multibyteId.length,
      multibyteBytes: Buffer.byteLength(multibyteId, 'utf8'),
    },
    transport: 'C ABI dsh_dispatch + blocking stdin/stdout bridge; strict JSON frame; no continuation capture',
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'blocking-ffi.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  Atomics.store(ctrl, SHUTDOWN, 1)
  Atomics.notify(ctrl, IN_POS)
  await worker.terminate()
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
