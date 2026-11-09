import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')

const v1 = `(library (dsh plugin demo v1)
  (export answer)
  (import (rnrs base (6)))
  (define (answer) 42))
`
const v2 = `(library (dsh plugin demo v2)
  (export answer)
  (import (rnrs base (6)))
  (define (answer) 43))
`

function sha256 (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function runOne (source) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url), {
      workerData: {
        projectFiles: [{ path: '/project/lib/plugin.scm', content: source, readonly: true }],
      },
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      worker.terminate().then(() => reject(new Error('timed out')))
    }, 30000)

    worker.on('message', (message) => {
      if (message.type === 'loaded') {
        worker.postMessage({ type: 'dispatch', id: 1, payload: '(request "ab" plugin-value)' })
      } else if (message.type === 'response' && message.id === 1) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.terminate().then(() => resolve(message))
      } else if (message.type === 'error' || message.type === 'exit') {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.terminate().then(() => reject(new Error(JSON.stringify(message))))
      }
    })
    worker.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

const r1 = await runOne(v1)
const r2 = await runOne(v2)
const v1Envelope = JSON.parse(r1.text)
const v2Envelope = JSON.parse(r2.text)

const checks = {
  v1: v1Envelope.ok === true && v1Envelope.value === 42,
  v2: v2Envelope.ok === true && v2Envelope.value === 43,
}
const ok = Object.values(checks).every(Boolean)

const result = {
  checkedAt: new Date().toISOString(),
  ok,
  checks,
  responses: [v1Envelope, v2Envelope],
  engine: {
    jsSha256: sha256(join(HERE, '10.4.1-c', 'scheme-c.js')),
    wasmSha256: sha256(join(HERE, '10.4.1-c', 'scheme-c.wasm')),
    dataSha256: sha256(join(HERE, '10.4.1-c', 'scheme-c.data')),
  },
  boundary: 'A/B run in separate Worker incarnations of the C ABI engine; registry is not shared.',
}

mkdirSync(RESULT_DIR, { recursive: true })
writeFileSync(join(RESULT_DIR, 'plugin-ab-c.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
process.exit(ok ? 0 : 1)
