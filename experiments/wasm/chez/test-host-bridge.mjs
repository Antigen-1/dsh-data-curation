import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-hb')
const control = new SharedArrayBuffer(16)
const response = new SharedArrayBuffer(1024 * 1024)
const controlView = new Int32Array(control)
const responseView = new Uint8Array(response)

const worker = new Worker(new URL('./host-bridge-probe-worker.cjs', import.meta.url), {
  workerData: { control, response },
  stdout: true,
  stderr: true,
})
worker.stdout.on('data', (chunk) => process.stdout.write(chunk))
worker.stderr.on('data', (chunk) => process.stderr.write(chunk))

let nextId = 0
const started = Date.now()

function dispatch (payload) {
  const id = ++nextId
  worker.postMessage({ type: 'dispatch', id, payload })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host bridge test timeout')), 10000)
    const onMessage = (message) => {
      if (message.id !== id) return
      clearTimeout(timer)
      worker.off('message', onMessage)
      if (message.type === 'response') resolve(message.text)
      else reject(new Error(message.message || 'worker error'))
    }
    worker.on('message', onMessage)
  })
}

worker.on('message', (message) => {
  if (message.type === 'host-call') {
    setTimeout(() => {
      const text = `pong:${message.request}`
      const bytes = Buffer.from(text, 'utf8')
      responseView.set(bytes)
      Atomics.store(controlView, 1, bytes.length)
      Atomics.store(controlView, 0, 1)
      Atomics.notify(controlView, 0)
    }, 30)
    return
  }
  if (message.type === 'error') {
    console.error(JSON.stringify(message))
    process.exitCode = 1
  }
})

worker.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

worker.on('exit', (code) => {
  if (code !== 0) {
    console.error(`worker exited ${code}`)
    process.exitCode = 1
  }
})

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('worker load timeout')), 15000)
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

const elapsedStart = Date.now()
const text = await dispatch('ping')
const elapsedMs = Date.now() - elapsedStart
const ok = text === 'pong:ping' && elapsedMs >= 20
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'host-bridge.json'), JSON.stringify({
  ok,
  request: 'ping',
  response: text,
  elapsedMs,
  totalElapsedMs: Date.now() - started,
  checkedAt: new Date().toISOString(),
}, null, 2) + '\n')
console.log(JSON.stringify({ ok, text, elapsedMs }))
await worker.terminate()
if (!ok) process.exitCode = 1
