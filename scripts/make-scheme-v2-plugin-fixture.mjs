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
const pluginSourceBase = [
  '(library (dsh plugin base (1 0 0))',
  '  (export bump)',
  '  (import (rnrs base (6)) (only (dsh lib math (1 0 0)) double))',
  '  (define (bump) (+ (double 20) 2)))',
  '',
].join('\n')
const pluginSource = [
  '(library (dsh plugin demo (1 0 0))',
  '  (export answer)',
  '  (import (rnrs base (6)) (only (dsh plugin base (1 0 0)) bump))',
  '  (define (answer) (bump)))',
  '',
].join('\n')
const ruleSource = [
  '(library (dsh rule rule.example (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (dsh plugin demo (1 0 0)))',
  '  (define (entry) (answer)))',
  '',
].join('\n')

const projectRoot = 'test/fixtures/scheme-v2/project'
const pluginPath = 'lib/dsh/plugin/demo/1.0.0.sls'
const basePluginPath = 'lib/dsh/plugin/base/1.0.0.sls'
mkdirSync(`${projectRoot}/rules/scheme/lib/dsh/plugin/demo`, { recursive: true })
mkdirSync(`${projectRoot}/rules/scheme/lib/dsh/plugin/base`, { recursive: true })
writeFileSync(`${projectRoot}/rules/scheme/${pluginPath}`, pluginSource)
writeFileSync(`${projectRoot}/rules/scheme/${basePluginPath}`, pluginSourceBase)

const vm = new CvmClient()
try {
  const hashRaw = await vm.dispatch(`(request "hash" source-tree-hash ${schemeString(pluginSource)})`)
  const hashResponse = JSON.parse(hashRaw)
  if (!hashResponse.ok) throw new Error(hashRaw)
  const pluginTree = hashResponse.value
  const baseHashRaw = await vm.dispatch(`(request "hash" source-tree-hash ${schemeString(pluginSourceBase)})`)
  const baseHashResponse = JSON.parse(baseHashRaw)
  if (!baseHashResponse.ok) throw new Error(baseHashRaw)
  const basePluginTree = baseHashResponse.value

  const modules = [
    { name: '(dsh lib base (1 0 0))', version: [1, 0, 0], source: base },
    { name: '(dsh lib math (1 0 0))', version: [1, 0, 0], source: math },
  ]
  const modulesDatum = `(${modules.map((m) => `(${m.name} (${m.version.join(' ')}) ${schemeString(m.source)})`).join(' ')})`
  const pluginsDatum = `((plugin "demo" (1 0 0) "library" ${schemeString(pluginPath)} ${schemeString(pluginTree)} (answer) ${schemeString(pluginSource)}) (plugin "base" (1 0 0) "library" ${schemeString(basePluginPath)} ${schemeString(basePluginTree)} (bump) ${schemeString(pluginSourceBase)}))`
  const request = `(request "fixture" pin-verify (rule ${schemeString('rule.example')} (1 0 0) ${schemeString(ruleSource)} ${modulesDatum} ${pluginsDatum} () (signature () number #f)))`
  const raw = await vm.dispatch(request)
  const response = JSON.parse(raw)
  if (!response.ok) throw new Error(raw)
  const values = response.value
  const pin = {
    schema: 'dsh-pin/v2',
    project: 'pin-v2-plugin-fixture-a',
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
      id: 'demo',
      version: [1, 0, 0],
      kind: 'library',
      path: pluginPath,
      treeHash: `sha256:${pluginTree}`,
      exports: ['answer'],
      capabilities: [],
    }, {
      id: 'base',
      version: [1, 0, 0],
      kind: 'library',
      path: basePluginPath,
      treeHash: `sha256:${basePluginTree}`,
      exports: ['bump'],
      capabilities: [],
    }],
    ffi: [],
    rules: [{
      id: 'rule.example',
      version: [1, 0, 0],
      sourceEncoding: 'utf-8-base64',
      sourceBase64: Buffer.from(ruleSource, 'utf8').toString('base64'),
      treeHash: `sha256:${values.treeHash}`,
      bundleHash: `sha256:${values.bundleHash}`,
      signature: { inputs: [], output: 'number', variadic: false },
      pluginEnvironmentHash: `sha256:${values.pluginEnvironmentHash}`,
      ffiEnvironmentHash: `sha256:${values.ffiEnvironmentHash}`,
      ruleHash: `sha256:${values.ruleHash}`,
    }],
  }
  writeFileSync('test/fixtures/scheme-v2/pin-v2-plugin-a.json', `${JSON.stringify(pin, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(pin, null, 2)}\n`)
} finally {
  await vm.close()
}
