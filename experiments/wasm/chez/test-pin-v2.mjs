import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPinV2 } from './pin-v2-loader.mjs'
import { decodeSourceBase64 } from './pin-v2-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'pin-v2-fixtures')
const REGISTRY = join(HERE, 'engine-registry.json')
const OUT = join(HERE, '..', 'results', 'chez', '10.4.1-c', 'pin-v2.json')

async function expectFailure (name, fn, code) {
  try {
    await fn()
    return { name, pass: false, expected: code, actual: 'NO-ERROR' }
  } catch (error) {
    return { name, pass: String(error.message).includes(code), expected: code, actual: error.message }
  }
}

const a = await loadPinV2({
  pinPath: join(FIXTURES, 'pin-v2-a.json'),
  registryPath: REGISTRY,
  assetsRoot: HERE,
})
const repeat = await loadPinV2({
  pinPath: join(FIXTURES, 'pin-v2-a.json'),
  registryPath: REGISTRY,
  assetsRoot: HERE,
})
const b = await loadPinV2({
  pinPath: join(FIXTURES, 'pin-v2-b.json'),
  registryPath: REGISTRY,
  assetsRoot: HERE,
})

const pinA = JSON.parse(readFileSync(join(FIXTURES, 'pin-v2-a.json'), 'utf8'))
const engine = JSON.parse(readFileSync(REGISTRY, 'utf8'))

const tampered = JSON.parse(JSON.stringify(pinA))
tampered.rules[0].treeHash = `sha256:${'0'.repeat(64)}`
const tamperedPath = join(FIXTURES, 'tmp-pin-tree.json')
writeFileSync(tamperedPath, JSON.stringify(tampered))

const badUtf8 = JSON.parse(JSON.stringify(pinA))
badUtf8.rules[0].sourceBase64 = '//4='
const badUtf8Path = join(FIXTURES, 'tmp-pin-utf8.json')
writeFileSync(badUtf8Path, JSON.stringify(badUtf8))

const unknownEngine = JSON.parse(JSON.stringify(pinA))
unknownEngine.engine.contract = 'not-installed'
const unknownEnginePath = join(FIXTURES, 'tmp-pin-engine.json')
writeFileSync(unknownEnginePath, JSON.stringify(unknownEngine))

const badRegistry = JSON.parse(JSON.stringify(engine))
badRegistry.engines['chez-wasm-c-10.4.1-v1'].engineArtifactHash = `sha256:${'f'.repeat(64)}`
const badRegistryPath = join(FIXTURES, 'tmp-engine-registry.json')
writeFileSync(badRegistryPath, JSON.stringify(badRegistry))

const versionMismatch = JSON.parse(JSON.stringify(pinA))
versionMismatch.modules[0].version = 'v2'
const versionMismatchPath = join(FIXTURES, 'tmp-pin-version.json')
writeFileSync(versionMismatchPath, JSON.stringify(versionMismatch))

const nameMismatch = JSON.parse(JSON.stringify(pinA))
nameMismatch.modules[0].name = '(dsh lib other v1)'
const nameMismatchPath = join(FIXTURES, 'tmp-pin-name.json')
writeFileSync(nameMismatchPath, JSON.stringify(nameMismatch))

const badKind = JSON.parse(JSON.stringify(pinA))
badKind.modules[0].name = '(dsh util math v1)'
badKind.modules[0].sourceBase64 = Buffer.from(
  '(library (dsh util math v1) (export double) (import (rnrs base (6))) (define (double x) (* x 2)))\n',
).toString('base64')
const badKindPath = join(FIXTURES, 'tmp-pin-kind.json')
writeFileSync(badKindPath, JSON.stringify(badKind))

const failures = []
failures.push(await expectFailure('tree-hash-tamper', () => loadPinV2({ pinPath: tamperedPath, registryPath: REGISTRY, assetsRoot: HERE }), 'E-PIN-MISMATCH:treeHash'))
failures.push(await expectFailure('source-utf8', () => loadPinV2({ pinPath: badUtf8Path, registryPath: REGISTRY, assetsRoot: HERE }), 'E-PIN-SOURCE-UTF8'))
failures.push(await expectFailure('engine-not-approved', () => loadPinV2({ pinPath: unknownEnginePath, registryPath: REGISTRY, assetsRoot: HERE }), 'E-ENGINE-NOT-APPROVED'))
failures.push(await expectFailure('engine-artifact-hash', () => loadPinV2({ pinPath: join(FIXTURES, 'pin-v2-a.json'), registryPath: badRegistryPath, assetsRoot: HERE }), 'E-ENGINE-MANIFEST-HASH'))
failures.push(await expectFailure('module-version-mismatch', () => loadPinV2({ pinPath: versionMismatchPath, registryPath: REGISTRY, assetsRoot: HERE }), 'E-PIN-MODULE-VERSION'))
failures.push(await expectFailure('module-name-mismatch', () => loadPinV2({ pinPath: nameMismatchPath, registryPath: REGISTRY, assetsRoot: HERE }), 'E-PIN-MODULE-NAME'))
failures.push(await expectFailure('module-kind', () => loadPinV2({ pinPath: badKindPath, registryPath: REGISTRY, assetsRoot: HERE }), 'E-PIN-MODULE-KIND'))
const afterFailures = await loadPinV2({ pinPath: join(FIXTURES, 'pin-v2-a.json'), registryPath: REGISTRY, assetsRoot: HERE })

for (const path of [tamperedPath, badUtf8Path, unknownEnginePath, badRegistryPath, versionMismatchPath, nameMismatchPath, badKindPath]) unlinkSync(path)

const result = {
  ok: a.ok && repeat.ok && b.ok && afterFailures.ok &&
    a.rules[0].ruleHash === repeat.rules[0].ruleHash &&
    a.rules[0].ruleHash !== b.rules[0].ruleHash &&
    failures.every((f) => f.pass),
  fresh: a,
  repeat,
  ab: { a: a.rules[0].ruleHash, b: b.rules[0].ruleHash, distinct: a.rules[0].ruleHash !== b.rules[0].ruleHash },
  failures,
  rollback: { afterFailuresOk: afterFailures.ok },
  checkedAt: new Date().toISOString(),
}
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
