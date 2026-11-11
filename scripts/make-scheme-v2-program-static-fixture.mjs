import { mkdirSync, writeFileSync } from 'node:fs'
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
const rule = [
  '(library (dsh rule rule.example (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)))',
  '  (define (entry) 42))',
  '',
].join('\n')
const program = [
  '(import (rnrs base (6)) (dsh rules (6)))',
  "(register-rule! 'rule.example '(1 0 0) (lambda () 1))",
  '42',
  '',
].join('\n')

const projectRoot = 'test/fixtures/scheme-v2/program-static-project'
const programPath = 'programs/010-conflict.scm'
mkdirSync(`${projectRoot}/rules/scheme/programs`, { recursive: true })
writeFileSync(`${projectRoot}/rules/scheme/${programPath}`, program)

const vm = new CvmClient()
try {
  const hashRaw = await vm.dispatch(`(request "hash" source-tree-hash ${schemeString(program)})`)
  const hashResponse = JSON.parse(hashRaw)
  if (!hashResponse.ok) throw new Error(hashRaw)
  const tree = hashResponse.value
  const modules = [
    { name: '(dsh lib base (1 0 0))', version: [1, 0, 0], source: base },
    { name: '(dsh lib math (1 0 0))', version: [1, 0, 0], source: math },
  ]
  const modulesDatum = `(${modules.map((m) => `(${m.name} (${m.version.join(' ')}) ${schemeString(m.source)})`).join(' ')})`
  const pluginsDatum = `((plugin "bootstrap" (1) "program" ${schemeString(programPath)} ${schemeString(tree)} () ${schemeString(program)}))`
  const request = `(request "fixture" pin-verify (rule ${schemeString('rule.example')} (1 0 0) ${schemeString(rule)} ${modulesDatum} ${pluginsDatum} () (signature () number #f)))`
  const raw = await vm.dispatch(request)
  const response = JSON.parse(raw)
  if (!response.ok) throw new Error(raw)
  const values = response.value
  const pin = {
    schema: 'dsh-pin/v2',
    project: 'pin-v2-program-static-fixture-a',
    engine: {
      contract: 'chez-wasm-c-10.4.1-v1',
      engineArtifactHash: engine.engineArtifactHash,
    },
    modules: modules.map((m) => ({
      name: m.name,
      version: m.version,
      sourceBase64: Buffer.from(m.source, 'utf8').toString('base64'),
    })),
    plugins: [{
      id: 'bootstrap',
      version: [1],
      kind: 'program',
      path: programPath,
      treeHash: `sha256:${tree}`,
      capabilities: [],
    }],
    ffi: [],
    rules: [{
      id: 'rule.example',
      version: [1, 0, 0],
      sourceEncoding: 'utf-8-base64',
      sourceBase64: Buffer.from(rule, 'utf8').toString('base64'),
      treeHash: `sha256:${values.treeHash}`,
      bundleHash: `sha256:${values.bundleHash}`,
      signature: { inputs: [], output: 'number', variadic: false },
      pluginEnvironmentHash: `sha256:${values.pluginEnvironmentHash}`,
      ffiEnvironmentHash: `sha256:${values.ffiEnvironmentHash}`,
      ruleHash: `sha256:${values.ruleHash}`,
    }],
  }
  writeFileSync('test/fixtures/scheme-v2/pin-v2-program-static-a.json', `${JSON.stringify(pin, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(pin, null, 2)}\n`)
} finally {
  await vm.close()
}
