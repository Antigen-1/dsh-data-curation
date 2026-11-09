import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'limits.json')
const CAP = 1 << 20
const MASK = CAP - 1
const SAMPLES = 5

function startWorker () {
  const control = new SharedArrayBuffer(8 * 4)
  const input = new SharedArrayBuffer(CAP)
  const output = new SharedArrayBuffer(CAP)
  const ctrl = new Int32Array(control)
  const state = {
    ctrl,
    input,
    output,
    inBuf: new Uint8Array(input),
    outBuf: new Uint8Array(output),
    buffered: Buffer.alloc(0),
    worker: null,
    memory: null,
  }
  state.worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
    workerData: { control, input, output },
  })
  state.worker.on('message', (message) => {
    if (message.type === 'loaded') state.memory = message.memory
  })
  return state
}

function drain (s) {
  const end = Atomics.load(s.ctrl, 2)
  const read = Atomics.load(s.ctrl, 3)
  if (end <= read) return
  const chunk = Buffer.alloc(end - read)
  for (let i = 0; i < chunk.length; i++) chunk[i] = s.outBuf[(read + i) & MASK]
  Atomics.store(s.ctrl, 3, end)
  s.buffered = Buffer.concat([s.buffered, chunk])
}

async function readLine (s) {
  const deadline = Date.now() + 15000
  while (!s.buffered.includes(0x0a)) {
    drain(s)
    if (Date.now() > deadline) throw new Error('timeout waiting for ready frame')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const at = s.buffered.indexOf(0x0a)
  const line = s.buffered.subarray(0, at).toString('ascii')
  s.buffered = s.buffered.subarray(at + 1)
  return line
}

async function readExact (s, n) {
  const deadline = Date.now() + 15000
  while (s.buffered.length < n) {
    drain(s)
    if (Date.now() > deadline) throw new Error('timeout waiting for ready payload')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const bytes = s.buffered.subarray(0, n)
  s.buffered = s.buffered.subarray(n)
  return bytes
}

async function stopWorker (s) {
  Atomics.store(s.ctrl, 4, 1)
  Atomics.notify(s.ctrl, 0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await s.worker.terminate()
}

async function main () {
  const samples = []
  for (let i = 0; i < SAMPLES; i++) {
    const s = startWorker()
    const header = await readLine(s)
    const payload = await readExact(s, Number(header))
    await readExact(s, 1)
    const ready = JSON.parse(payload.toString('utf8'))
    if (ready.ready !== true) throw new Error(`unexpected ready frame: ${payload}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const rss = process.memoryUsage().rss
    samples.push({
      start: i + 1,
      rss,
      wasmBytes: s.memory?.wasmBytes ?? null,
      ready: true,
    })
    await stopWorker(s)
  }

  const idlePeak = Math.max(...samples.map((sample) => sample.rss))
  const memoryBytes = Math.ceil((idlePeak + 32 * 1024 * 1024) / 65536) * 65536
  const result = {
    ok: true,
    sampledAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    starts: samples,
    idlePeak,
    memoryFormula: 'ceil((idlePeak + 32 MiB) / 64 KiB) * 64 KiB',
    memoryBytes,
    limits: {
      wallTimeoutMs: 2000,
      maxOutputBytes: 1000000,
      memoryBytes,
    },
  }
  mkdirSync(dirname(RESULT), { recursive: true })
  writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}

await main()
