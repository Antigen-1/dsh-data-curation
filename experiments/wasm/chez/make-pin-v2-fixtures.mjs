import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CvmClient } from './c-vm-client.mjs'
import {
  canonicalJson,
  decodeSourceBase64,
  sha256Hex,
  schemeString,
} from './pin-v2-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '10.4.1-c')
const FIXTURES = join(HERE, 'pin-v2-fixtures')
const CONTRACT = 'chez-wasm-c-10.4.1-v1'

const closure = ['scheme-c.js', 'scheme-c.wasm', 'scheme-c.data', 'online-vm-abi.json'].map((name) => {
  const bytes = readFileSync(join(ASSETS, name))
  return { path: name, sha256: sha256Hex(bytes), size: bytes.length }
})
const engineArtifactHash = `sha256:${sha256Hex(canonicalJson({ contract: CONTRACT, files: closure }))}`
const registry = {
  schema: 'dsh-engine-registry/v1',
  engines: {
    [CONTRACT]: {
      assetsDir: '10.4.1-c',
      engineArtifactHash,
      closure,
    },
  },
}
writeFileSync(join(HERE, 'engine-registry.json'), `${JSON.stringify(registry, null, 2)}\n`)

async function buildPin (name, sourceName, version, ruleId) {
  const ruleSource = readFileSync(join(FIXTURES, sourceName), 'utf8')
  const moduleFiles = [
    { name: '(dsh lib base v1)', file: 'base.scm' },
    { name: '(dsh lib math v1)', file: 'util.scm' },
  ]
  const modules = moduleFiles.map(({ name, file, version: moduleVersion = 'v1' }) => ({
    name,
    version: moduleVersion,
    sourceBase64: Buffer.from(readFileSync(join(FIXTURES, file), 'utf8'), 'utf8').toString('base64'),
  }))
  const modulesDatum = `(${modules.map((module) => {
    const source = decodeSourceBase64(module.sourceBase64)
    return `(${schemeString(module.name)} ${schemeString(module.version)} ${schemeString(source)})`
  }).join(' ')})`
  const request = `(request "pin" pin-verify (rule ${schemeString(ruleId)} ${schemeString(version)} ${schemeString(ruleSource)} ${modulesDatum} () () (signature () boolean #f)))`
  const vm = new CvmClient()
  let hashes
  try {
    const response = JSON.parse(await vm.dispatch(request, 10000))
    if (!response.ok) throw new Error(JSON.stringify(response))
    hashes = response.value
  } finally {
    await vm.close()
  }
  return {
    schema: 'dsh-pin/v2',
    project: name,
    engine: { contract: CONTRACT, engineArtifactHash },
    modules,
    plugins: [],
    ffi: [],
    rules: [{
      id: ruleId,
      version,
      sourceEncoding: 'utf-8-base64',
      sourceBase64: Buffer.from(ruleSource, 'utf8').toString('base64'),
      treeHash: `sha256:${hashes.treeHash}`,
      bundleHash: `sha256:${hashes.bundleHash}`,
      signature: { inputs: [], output: 'boolean', variadic: false },
      pluginEnvironmentHash: `sha256:${hashes.pluginEnvironmentHash}`,
      ffiEnvironmentHash: `sha256:${hashes.ffiEnvironmentHash}`,
      ruleHash: `sha256:${hashes.ruleHash}`,
    }],
  }
}

const pinA = await buildPin('pin-v2-fixture-a', 'rule.scm', '1.0.0', 'rule.example')
const pinB = await buildPin('pin-v2-fixture-b', 'rule-b.scm', '1.0.1', 'rule.example')
writeFileSync(join(FIXTURES, 'pin-v2-a.json'), `${JSON.stringify(pinA, null, 2)}\n`)
writeFileSync(join(FIXTURES, 'pin-v2-b.json'), `${JSON.stringify(pinB, null, 2)}\n`)
console.log(JSON.stringify({ registry: engineArtifactHash, pins: [pinA.project, pinB.project] }))
