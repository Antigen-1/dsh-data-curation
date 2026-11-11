import { mkdirSync, writeFileSync } from 'node:fs'
import { CvmClient } from '../lib/rules/scheme/v2/client.js'
import { schemeString, verifyEngine } from '../lib/rules/scheme/v2/pin-lib.js'

const engine = verifyEngine(
  'assets/chez-wasm/engine-registry.json',
  'chez-wasm-c-10.4.1-v1',
  'assets/chez-wasm/',
)

const program = [
  '(import (rnrs base (6))',
  '        (dsh rules (6))',
  '        (dsh ffi (6)))',
  "(register-rule! 'ffi-total '(1 0 0) (lambda (x) (ffi-call \"math.add\" x 21)))",
  '(list (ffi-call "math.add" 20 22) 42)',
  '',
].join('\n')

const projectRoot = 'test/fixtures/scheme-v2/program-ffi-project'
const programPath = 'programs/020-ffi.scm'
mkdirSync(`${projectRoot}/rules/scheme/programs`, { recursive: true })
writeFileSync(`${projectRoot}/rules/scheme/${programPath}`, program)

const vm = new CvmClient()
try {
  const hashRaw = await vm.dispatch(`(request "hash" source-tree-hash ${schemeString(program)})`)
  const hashResponse = JSON.parse(hashRaw)
  if (!hashResponse.ok) throw new Error(hashRaw)
  const treeHash = `sha256:${hashResponse.value}`
  const pin = {
    schema: 'dsh-pin/v2',
    project: 'pin-v2-program-ffi-fixture-a',
    engine: {
      contract: 'chez-wasm-c-10.4.1-v1',
      engineArtifactHash: engine.engineArtifactHash,
    },
    modules: [],
    plugins: [{
      id: 'ffi-bootstrap',
      version: [1],
      kind: 'program',
      path: programPath,
      treeHash,
      capabilities: [],
    }],
    ffi: [{
      id: 'math.add',
      subjects: [{ kind: 'program', id: 'ffi-bootstrap', version: [1] }],
    }],
    rules: [],
  }
  writeFileSync('test/fixtures/scheme-v2/pin-v2-program-ffi-a.json', `${JSON.stringify(pin, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(pin, null, 2)}\n`)
} finally {
  await vm.close()
}
