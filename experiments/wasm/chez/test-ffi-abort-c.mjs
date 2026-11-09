import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { FfiBroker } from './ffi-broker.mjs'
import { createFfiRegistry } from './ffi-registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'results', 'chez', '10.4.1-c', 'ffi-abort-c.json')
const CAP = 1 << 20
const MASK = CAP - 1
const IN_POS = 0
const IN_READ = 1
const OUT_POS = 2
const OUT_READ = 3

function startWorker () {
  const control = new SharedArrayBuffer(8 * 4)
  const input = new SharedArrayBuffer(CAP)
  const output = new SharedArrayBuffer(CAP)
  const ctrl = new Int32Array(control)
  const inBuf = new Uint8Array(input)
  const outBuf = new Uint8Array(output)
  let inPos = 0
  let outRead = 0
  let buffered = Buffer.alloc(0)
  let loaded = false
  let exited = null
  let nextId = 0
  const pending = new Map()
  const worker = new Worker(new URL('./host-bridge-c-worker.cjs', import.meta.url), {
    workerData: { control, input, output, guestFile: '/online-vm-c.scm' },
  })
  worker.on('message', (message) => {
    if (message.type === 'loaded') loaded = true
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.type === 'response') waiter.resolve(message.text)
    else waiter.reject(new Error(message.message || 'worker error'))
  })
  worker.on('exit', (code) => { exited = code })
  return {
    worker,
    ctrl,
    inBuf,
    outBuf,
    loaded: () => loaded,
    request (payload) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ type: 'dispatch', id, payload })
      })
    },
    exited: () => exited,
    send (bytes) {
      const end = Atomics.load(ctrl, IN_POS)
      const read = Atomics.load(ctrl, IN_READ)
      if (end - read + bytes.length > CAP) throw new Error('input ring full')
      for (let i = 0; i < bytes.length; i++) {
        inBuf[(end + i) & MASK] = bytes[i]
        Atomics.store(ctrl, IN_POS, ++inPos)
      }
      Atomics.notify(ctrl, IN_POS)
    },
    async line (timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const end = Atomics.load(ctrl, OUT_POS)
        if (end > outRead) {
          const chunk = Buffer.alloc(end - outRead)
          for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
          outRead = end
          Atomics.store(ctrl, OUT_READ, outRead)
          Atomics.notify(ctrl, OUT_READ)
          buffered = Buffer.concat([buffered, chunk])
        }
        const at = buffered.indexOf(0x0a)
        if (at >= 0) {
          const line = buffered.subarray(0, at).toString('utf8')
          buffered = buffered.subarray(at + 1)
          return line
        }
        if (Date.now() > deadline) throw new Error('timed out waiting for DSH-FFI')
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    },
  }
}

async function waitLoaded (vm) {
  const deadline = Date.now() + 15000
  while (!vm.loaded()) {
    if (Date.now() > deadline) throw new Error('worker load timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const first = startWorker()
await waitLoaded(first)
void first.request('(request "f1" ffi-call "r1" "ffi" "rule-a" "delay.slow" ())').catch(() => {})
const line = await first.line()
const fields = line.split('\t')
if (fields.length !== 2 || fields[0] !== 'DSH-FFI') throw new Error(`bad frame: ${line}`)
const frame = JSON.parse(fields[1])
if (Object.keys(frame).sort().join(',') !== 'args,id,kind,rid,rule,target') {
  throw new Error('unexpected frame keys')
}

let aborted = 0
let terminated = false
const broker = new FfiBroker({
  capabilities: {},
  ffi: createFfiRegistry({
    manifest: {
      version: 1,
      modules: { delay: { functions: { slow: { arity: 0, args: [], returns: 'string', mode: 'async' } } } },
    },
    handlers: { 'delay.slow': () => new Promise((resolve) => setTimeout(() => resolve('late'), 300)) },
  }),
  abort: async () => {
    aborted += 1
    terminated = true
    await first.worker.terminate()
    return { terminated: true }
  },
  resume: async () => {},
  incarnationId: 'abort-test-1',
  timeoutMs: 50,
})
const outcome = await broker.dispatch({
  requestId: randomUUID(),
  ruleHash: frame.rule,
  kind: frame.kind,
  target: frame.target,
  args: frame.args,
})
const timeoutCode = outcome.error ?? null

const exitDeadline = Date.now() + 10000
while (first.exited() === null && Date.now() < exitDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

const second = startWorker()
await waitLoaded(second)
const secondResponse = await second.request('(request "g" get)')
await second.worker.terminate()

const result = {
  ok: timeoutCode === 'E-TIMEOUT' && aborted === 1 && terminated === true &&
      first.exited() !== null && secondResponse.includes('"ok":true'),
  checkedAt: new Date().toISOString(),
  first: { timeoutCode, aborted, terminated, exitCode: first.exited(), audit: broker.audit.at(-1) },
  second: { response: secondResponse },
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
