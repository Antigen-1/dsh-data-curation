import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')

const worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url), { workerData: {} })
let nextId = 1
let ready = false
let stderrText = ''

function waitFor (predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    const poll = setInterval(() => {
      const value = predicate()
      if (value) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve(value)
      }
    }, 5)
  })
}

const loadedPromise = new Promise((resolve, reject) => {
  worker.on('message', (message) => {
    if (message.type === 'loaded') {
      ready = true
      resolve()
    } else if (message.type === 'error' && !ready) {
      reject(new Error(message.message))
    }
  })
  worker.on('error', reject)
})

await loadedPromise

const result = await new Promise((resolve, reject) => {
  const id = `cap-${nextId++}`
  const timer = setTimeout(() => reject(new Error('dispatch timeout')), 15000)
  const onMessage = (message) => {
    if (message.id !== id) return
    clearTimeout(timer)
    worker.off('message', onMessage)
    if (message.type === 'error') {
      stderrText = message.stderr || ''
      resolve({ code: message.code, message: message.message })
    } else {
      reject(new Error(`expected output cap error, got ${JSON.stringify(message)}`))
    }
  }
  worker.on('message', onMessage)
  worker.postMessage({ type: 'dispatch', id, payload: '(request "cap" big-output)' })
})

const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 5000)
  worker.on('exit', (code) => {
    clearTimeout(timer)
    resolve(code)
  })
})

const ok = result.code === 'E-OUTPUT-LIMIT' && exited === 70
const output = {
  ok,
  checkedAt: new Date().toISOString(),
  error: { code: result.code, message: result.message.split('\n')[0] },
  exitCode: exited,
  maxOutputBytes: 1000000,
  boundary: 'Worker rejects outLen > maxOutputBytes before HEAPU8.slice and terminates the incarnation.',
  stderr: stderrText.slice(-1000),
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'output-cap.json'), JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify(output, null, 2))
if (!ok) process.exitCode = 1
