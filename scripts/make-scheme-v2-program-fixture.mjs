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
const program = [
  '(import (rnrs base (6))',
  '        (only (dsh lib math (1 0 0)) double)',
  '        (dsh rules (6)))',
  "(set-rule-option! 'total 'mode \"strict\")",
  "(register-rule! 'total '(1 0 0) (lambda (x) (double x)))",
  "(list (rule-option 'total 'mode) 42)",
  '',
].join('\n')

const projectRoot = 'test/fixtures/scheme-v2/program-project'
const programPath = 'programs/010-bootstrap.scm'
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
  const pin = {
    schema: 'dsh-pin/v2',
    project: 'pin-v2-program-fixture-a',
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
    rules: [],
  }
  writeFileSync('test/fixtures/scheme-v2/pin-v2-program-a.json', `${JSON.stringify(pin, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(pin, null, 2)}\n`)
} finally {
  await vm.close()
}
