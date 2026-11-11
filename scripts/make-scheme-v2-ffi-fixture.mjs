import { writeFileSync } from 'node:fs'
import { CvmClient } from '../lib/rules/scheme/v2/client.js'
import { schemeString, verifyEngine } from '../lib/rules/scheme/v2/pin-lib.js'

const engine = verifyEngine(
  'assets/chez-wasm/engine-registry.json',
  'chez-wasm-c-10.4.1-v1',
  'assets/chez-wasm/',
)

const base = [
  '(library (dsh lib base (1 0 0))',
  '  (export two)',
  '  (import (rnrs base (6)))',
  '  (define (two) 2))',
  '',
].join('\n')
const math = [
  '(library (dsh lib math (1 0 0))',
  '  (export double)',
  '  (import (rnrs base (6)) (only (dsh lib base (1 0 0)) two))',
  '  (define (double x) (* x (two))))',
  '',
].join('\n')
const ruleSource = [
  '(library (dsh rule rule.example (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (dsh ffi (6)))',
  '  (define (entry) (ffi-call "math.add" 20 22)))',
  '',
].join('\n')
const modules = [
  { name: '(dsh lib base (1 0 0))', version: [1, 0, 0], source: base },
  { name: '(dsh lib math (1 0 0))', version: [1, 0, 0], source: math },
]
const ffi = [{
  id: 'math.add',
  subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
}]
const modulesDatum = `(${modules.map((m) => `(${m.name} (${m.version.join(' ')}) ${schemeString(m.source)})`).join(' ')})`
const ffiDatum = `(${ffi.map((entry) => `(${schemeString(JSON.stringify(entry))})`).join(' ')})`
const request = `(request "fixture" pin-verify (rule ${schemeString('rule.example')} (1 0 0) ${schemeString(ruleSource)} ${modulesDatum} () ${ffiDatum} (signature () boolean #f)))`
const vm = new CvmClient()
try {
  const raw = await vm.dispatch(request)
  const response = JSON.parse(raw)
  if (!response.ok) throw new Error(raw)
  const values = response.value
  const pin = {
    schema: 'dsh-pin/v2',
    project: 'pin-v2-ffi-fixture-a',
    engine: {
      contract: 'chez-wasm-c-10.4.1-v1',
      engineArtifactHash: engine.engineArtifactHash,
    },
    modules: modules.map((m) => ({
      name: m.name,
      version: m.version,
      sourceBase64: Buffer.from(m.source, 'utf8').toString('base64'),
    })),
    plugins: [],
    ffi,
    rules: [{
      id: 'rule.example',
      version: [1, 0, 0],
      sourceEncoding: 'utf-8-base64',
      sourceBase64: Buffer.from(ruleSource, 'utf8').toString('base64'),
      treeHash: `sha256:${values.treeHash}`,
      bundleHash: `sha256:${values.bundleHash}`,
      signature: { inputs: [], output: 'boolean', variadic: false },
      pluginEnvironmentHash: `sha256:${values.pluginEnvironmentHash}`,
      ffiEnvironmentHash: `sha256:${values.ffiEnvironmentHash}`,
      ruleHash: `sha256:${values.ruleHash}`,
    }],
  }
  writeFileSync('test/fixtures/scheme-v2/pin-v2-ffi-a.json', `${JSON.stringify(pin, null, 2)}\n`)
} finally {
  await vm.close()
}
