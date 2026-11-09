import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')

const projectSource = `(library (dsh plugin mem v1)
  (export answer)
  (import (rnrs base (6)))
  (define (answer) 42))
`

function sha256 (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run () {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url), {
      workerData: {
        projectFiles: [
          { path: '/project/lib/mem.scm', content: projectSource, readonly: true },
        ],
      },
    })
    let loaded = false
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      worker.terminate().then(() => reject(new Error('timed out')))
    }, 30000)

    worker.on('message', (message) => {
      if (message.type === 'loaded' && !loaded) {
        loaded = true
        worker.postMessage({ type: 'dispatch', id: 1, payload: '(request "m1" memfs-test)' })
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

const response = await run()
let guest
try {
  const envelope = JSON.parse(response.text)
  guest = envelope.value
} catch (error) {
  throw new Error(`bad response JSON: ${response.text}`)
}

const checks = {
  projectValue: guest.projectValue === 42,
  projectWriteDenied: guest.projectWriteDenied === true,
  outWrite: guest.outWrite === true,
  outRead: guest.outRead === true,
  loadOk: guest.loadOk === true,
  hostOutSize: response.outSize === 2,
  hostOutCount: response.outCount === 1,
}
const ok = Object.values(checks).every(Boolean)

const result = {
  checkedAt: new Date().toISOString(),
  ok,
  checks,
  guest,
  host: { outSize: response.outSize, outCount: response.outCount },
  engine: {
    jsSha256: sha256(join(HERE, '10.4.1-c', 'scheme-c.js')),
    wasmSha256: sha256(join(HERE, '10.4.1-c', 'scheme-c.wasm')),
    dataSha256: sha256(join(HERE, '10.4.1-c', 'scheme-c.data')),
  },
  transport: 'C ABI dsh_init/dsh_dispatch + dsh_mount_file/dsh_out_size/dsh_out_count',
  boundary: 'MEMFS is Emscripten virtual FS; project files are mounted read-only; out quota is checked by host after dispatch.',
}

mkdirSync(RESULT_DIR, { recursive: true })
writeFileSync(join(RESULT_DIR, 'memfs.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
process.exit(ok ? 0 : 1)
