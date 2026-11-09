import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1')
const CAP = 1 << 20
const MASK = CAP - 1

function runScript (scriptFile, extraFiles) {
  return new Promise((resolve, reject) => {
    const control = new SharedArrayBuffer(8 * 4)
    const input = new SharedArrayBuffer(CAP)
    const output = new SharedArrayBuffer(CAP)
    const ctrl = new Int32Array(control)
    const outBuf = new Uint8Array(output)
    const OUT_POS = 2
    const OUT_READ = 3
    let outRead = 0
    const chunks = []
    let stderrText = ''
    let exit = null
    let failure = null

    const drain = () => {
      const end = Atomics.load(ctrl, OUT_POS)
      if (end <= outRead) return
      const chunk = Buffer.alloc(end - outRead)
      for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
      outRead = end
      Atomics.store(ctrl, OUT_READ, outRead)
      Atomics.notify(ctrl, OUT_READ)
      chunks.push(chunk)
    }

    const worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
      workerData: { control, input, output, scriptFile, extraFiles },
    })
    worker.on('message', (message) => {
      if (message.type === 'exit') {
        exit = message
        stderrText = message.stderr || ''
      } else if (message.type === 'error') {
        failure = message
        stderrText = message.stderr || ''
      }
    })
    worker.on('error', (error) => { failure = { message: error.stack ?? String(error) } })

    const deadline = Date.now() + 30000
    const poll = () => {
      if (exit !== null || failure !== null) {
        drain()
        worker.terminate().then(() => {
          if (failure) return reject(new Error(JSON.stringify(failure)))
          if (exit === null) return reject(new Error('timed out waiting for script exit'))
          resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr: stderrText, code: exit.code })
        })
        return
      }
      if (Date.now() >= deadline) {
        worker.terminate().then(() => reject(new Error('timed out waiting for script exit')))
        return
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}

function parseCases (stdout) {
  return stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('CASE '))
    .map((line) => {
      const match = line.match(/^CASE (\S+) (PASS|FAIL) (.*)$/)
      return match ? { name: match[1], pass: match[2] === 'PASS', detail: match[3] } : null
    })
    .filter(Boolean)
}

function sha256 (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const base = await runScript('plugin-loader-test.scm', ['plugin-loader.scm', 'source-tree-reader.scm'])
const abV1 = await runScript('plugin-ab-v1.scm', ['plugin-loader.scm', 'source-tree-reader.scm'])
const abV2 = await runScript('plugin-ab-v2.scm', ['plugin-loader.scm', 'source-tree-reader.scm'])
const cases = parseCases(base.stdout)
const ab1 = (abV1.stdout.match(/^AB (\d+)$/m) || [])[1]
const ab2 = (abV2.stdout.match(/^AB (\d+)$/m) || [])[1]
const ok = base.code === 0 && abV1.code === 0 && abV2.code === 0 &&
  ab1 === '42' && ab2 === '43' && cases.every((c) => c.pass)

const result = {
  checkedAt: new Date().toISOString(),
  ok,
  engine: {
    assetDir: 'experiments/wasm/chez/10.4.1',
    schemeWasmSha256: sha256(join(HERE, '10.4.1', 'scheme.wasm')),
    schemeDataSha256: sha256(join(HERE, '10.4.1', 'scheme.data')),
  },
  transport: 'legacy Worker + SharedArrayBuffer device bridge; not C ABI',
  loaderTest: {
    exitCode: base.code,
    stderr: base.stderr,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass).length,
    cases,
  },
  abIsolation: {
    samePluginId: 'demo',
    v1: { value: ab1 === undefined ? null : Number(ab1), exitCode: abV1.code, stderr: abV1.stderr },
    v2: { value: ab2 === undefined ? null : Number(ab2), exitCode: abV2.code, stderr: abV2.stderr },
    separateIncarnations: true,
  },
}

mkdirSync(RESULT_DIR, { recursive: true })
writeFileSync(join(RESULT_DIR, 'plugin-isolation.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ok, passed: result.loaderTest.passed, failed: result.loaderTest.failed, ab1, ab2 }, null, 2))
process.exit(ok ? 0 : 1)
