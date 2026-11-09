import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')

function sha256 (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run () {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url), {
      workerData: {},
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
        worker.postMessage({ type: 'dispatch', id: 1, payload: '(request "q1" memfs-quota)' })
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
  quotaDenied: guest.quotaDenied === true,
  outSizeAtCap: response.outSize === 65536,
  outCountOne: response.outCount === 1,
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
  boundary: 'Host FS write guard rejects /out writes above 65536 bytes with ENOSPC before the guest write.',
}

mkdirSync(RESULT_DIR, { recursive: true })
writeFileSync(join(RESULT_DIR, 'memfs-quota.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
process.exit(ok ? 0 : 1)
