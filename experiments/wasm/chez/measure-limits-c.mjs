import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1-c', 'limits-c.json')
const SAMPLES = 5

function startWorker () {
  const worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url))
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('load timeout')), 30000)
    worker.once('message', (message) => {
      clearTimeout(timer)
      if (message.type === 'loaded') resolve(message)
      else reject(new Error(message.message || `unexpected ${message.type}`))
    })
    worker.once('error', reject)
  })
  return { worker, loaded }
}

const samples = []
for (let i = 0; i < SAMPLES; i++) {
  const { worker, loaded } = startWorker()
  const message = await loaded
  samples.push({
    start: i + 1,
    rss: message.memory.rss,
    wasmBytes: message.memory.wasmBytes,
    ready: true,
  })
  await worker.terminate()
}

const idlePeak = Math.max(...samples.map((sample) => sample.rss))
const memoryBytes = Math.ceil((idlePeak + 32 * 1024 * 1024) / 65536) * 65536
const result = {
  ok: true,
  transport: 'c-abi',
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
