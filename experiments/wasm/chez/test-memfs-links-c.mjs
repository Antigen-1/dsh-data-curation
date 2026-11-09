import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'results', 'chez', '10.4.1-c', 'memfs-links.json')
const worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url), {
  workerData: { probeFsLinks: true },
})

const message = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fs-link probe timeout')), 15000)
  worker.on('message', (value) => {
    if (value.type === 'fs-link-probe') {
      clearTimeout(timer)
      resolve(value)
    }
    if (value.type === 'error') {
      clearTimeout(timer)
      reject(new Error(value.message))
    }
  })
  worker.on('error', reject)
})
await worker.terminate()

const results = message.results
const values = Object.values(results)
const result = {
  ok: values.length === 4 && values.every((value) => value === 30 || value === 'not-implemented'),
  checkedAt: new Date().toISOString(),
  results,
  expected: 'EPERM (30) for available symlink/link/rename operations crossing /project',
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
