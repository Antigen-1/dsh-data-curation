import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CvmClient } from './c-vm-client.mjs'
import { decodeSourceBase64, schemeString } from './pin-v2-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'pin-v2-fixtures')
const OUT_DIR = path.join(HERE, '..', 'results', 'chez', '10.4.1-c')
const OUT = path.join(OUT_DIR, 'pin-load-imports.json')

const pin = JSON.parse(readFileSync(path.join(FIXTURES, 'pin-v2-a.json'), 'utf8'))
const rule = pin.rules[0]
const rawHash = (value) => String(value).replace(/^sha256:/, '')
const signature = `(signature (${rule.signature.inputs.join(' ')}) ${rule.signature.output} ${rule.signature.variadic ? '#t' : '#f'})`

// The extra module imports a rule library. The rule tuple itself is taken from
// the valid fixture. New code must reject the import before trying to recompute
// the (now stale) bundle; old code that includes rules in the allowed name set
// reaches the hash recomputation and fails with E-PIN-MISMATCH-BUNDLE instead.
const evilSource = `(library (dsh lib evil v1)
  (export dummy)
  (import (rnrs base (6)) (dsh rule example v1))
  (define (dummy) 1))`
const modules = [
  ...pin.modules,
  {
    name: '(dsh lib evil v1)',
    version: 'v1',
    sourceBase64: Buffer.from(evilSource, 'utf8').toString('base64'),
  },
]
const moduleDatums = modules.map((module) => {
  const source = decodeSourceBase64(module.sourceBase64)
  return `(${schemeString(module.name)} ${schemeString(module.version)} ${schemeString(source)})`
})
const ruleSource = decodeSourceBase64(rule.sourceBase64)
const ruleDatum = `(rule ${schemeString(rule.id)} ${schemeString(rule.version)} ${schemeString(ruleSource)} ${signature} ${schemeString(rawHash(rule.treeHash))} ${schemeString(rawHash(rule.bundleHash))} ${schemeString(rawHash(rule.pluginEnvironmentHash))} ${schemeString(rawHash(rule.ffiEnvironmentHash))} ${schemeString(rawHash(rule.ruleHash))})`
const request = `(request "import-check" pin-load (pin () () (${moduleDatums.join(' ')}) (${ruleDatum})))`

const vm = new CvmClient()
let response
try {
  response = JSON.parse(await vm.dispatch(request, 5000))
} finally {
  await vm.close()
}

const result = {
  ok: response.ok === false && String(response.error?.code).includes('E-IMPORT-DENIED'),
  error: response.error,
  checkedAt: new Date().toISOString(),
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
assert.equal(result.ok, true)
