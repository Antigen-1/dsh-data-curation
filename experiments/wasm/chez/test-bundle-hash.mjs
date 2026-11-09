import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CvmClient } from './c-vm-client.mjs'
import { schemeString } from './pin-v2-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')
const RESULT = join(OUT_DIR, 'bundle-hash.json')
rmSync(RESULT, { force: true })

const rule = `(library (dsh rule test v1)
  (export answer)
  (import (rnrs base (6)) (dsh lib math v1))
  (define (answer) (double 21)))`
const baseV1 = `(library (dsh lib math v1)
  (export double)
  (import (rnrs base (6)))
  (define (double x) (+ x x)))`
const edgeV1 = `(library (dsh lib math v1)
  (export double)
  (import (rnrs base (6)) (dsh util extra v1))
  (define (double x) (+ x x)))`
const baseV2 = `(library (dsh lib math v2)
  (export double)
  (import (rnrs base (6)))
  (define (double x) (+ x x)))`

function request (id, name, version, source) {
  return `(request ${schemeString(id)} pin-verify (rule ${schemeString('rule.test')} ${schemeString('1.0.0')} ${schemeString(rule)} ((${schemeString(name)} ${schemeString(version)} ${schemeString(source)})) () () (signature () boolean #f)))`
}

const vm = new CvmClient()
try {
  const a = JSON.parse(await vm.dispatch(request('a', '(dsh lib math v1)', 'v1', baseV1)))
  const b = JSON.parse(await vm.dispatch(request('b', '(dsh lib math v1)', 'v1', baseV1)))
  const c = JSON.parse(await vm.dispatch(request('c', '(dsh lib math v1)', 'v1', edgeV1)))
  const d = JSON.parse(await vm.dispatch(request('d', '(dsh lib math v2)', 'v2', baseV2)))
  const repeatStable = a.value.bundleHash === b.value.bundleHash
  const importEdgeChangesBundle = a.value.bundleHash !== c.value.bundleHash
  const versionChangesBundle = a.value.bundleHash !== d.value.bundleHash
  const result = {
    ok: a.ok && b.ok && c.ok && d.ok && repeatStable && importEdgeChangesBundle && versionChangesBundle,
    checkedAt: new Date().toISOString(),
    repeatStable,
    importEdgeChangesBundle,
    versionChangesBundle,
    hashes: {
      base: a.value.bundleHash,
      repeat: b.value.bundleHash,
      importEdge: c.value.bundleHash,
      version2: d.value.bundleHash,
    },
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) throw new Error(JSON.stringify(result))
} finally {
  await vm.close()
}
