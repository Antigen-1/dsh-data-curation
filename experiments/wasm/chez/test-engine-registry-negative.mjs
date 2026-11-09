import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { validateAbiManifest, verifyEngine } from './pin-v2-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')
const ASSETS = join(HERE, '10.4.1-c')
const REGISTRY = join(HERE, 'engine-registry.json')
const CONTRACT = 'chez-wasm-c-10.4.1-v1'
const valid = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-engine-negative-'))
const cases = []

function expectFailure (name, mutate, expected) {
  const copy = structuredClone(valid)
  mutate(copy.engines[CONTRACT])
  const path = join(tmp, `${name}.json`)
  writeFileSync(path, JSON.stringify(copy))
  let actual = 'NO-ERROR'
  try {
    verifyEngine(path, CONTRACT, HERE)
  } catch (error) {
    actual = String(error && error.message ? error.message : error)
  }
  const pass = actual.startsWith(expected)
  cases.push({ name, pass, expected, actual })
  if (!pass) throw new Error(`${name}: expected ${expected}, got ${actual}`)
}

try {
  expectFailure('missing-file', (entry) => { entry.closure = entry.closure.slice(0, 3) }, 'E-ENGINE-CLOSURE')
  expectFailure('extra-file', (entry) => {
    entry.closure[0].path = 'extra.bin'
  }, 'E-ENGINE-UNEXPECTED')
  expectFailure('duplicate-file', (entry) => { entry.closure[1].path = entry.closure[0].path }, 'E-ENGINE-DUPLICATE')
  expectFailure('bad-path', (entry) => { entry.closure[0].path = 'scheme-c\\js' }, 'E-ENGINE-PATH')
  expectFailure('size-mismatch', (entry) => { entry.closure[0].size += 1 }, 'E-ENGINE-SIZE')
  expectFailure('digest-mismatch', (entry) => { entry.closure[0].sha256 = '0'.repeat(64) }, 'E-ENGINE-HASH')
  expectFailure('assets-traversal', (entry) => { entry.assetsDir = '../10.4.1-c' }, 'E-ENGINE-PATH')
  expectFailure('aggregate-mismatch', (entry) => { entry.engineArtifactHash = `sha256:${'0'.repeat(64)}` }, 'E-ENGINE-MANIFEST-HASH')
  expectFailure('data-file-digest', (entry) => { entry.dataArchive.files[0].sha256 = '0'.repeat(64) }, 'E-ENGINE-DATA-MANIFEST')
  expectFailure('data-package-size', (entry) => { entry.dataArchive.remotePackageSize += 1 }, 'E-ENGINE-DATA-MANIFEST')

  const abi = JSON.parse(readFileSync(join(ASSETS, 'online-vm-abi.json'), 'utf8'))
  for (const [name, mutate, expected] of [
    ['abi-contract', (value) => { value.contract = 'other' }, 'E-ENGINE-ABI'],
    ['abi-guest', (value) => { value.guest = 'other.scm' }, 'E-ENGINE-ABI'],
    ['abi-export', (value) => { value.exports = value.exports.filter((item) => item !== '_dsh_dispatch') }, 'E-ENGINE-ABI-EXPORT'],
  ]) {
    const copy = structuredClone(abi)
    mutate(copy)
    let actual = 'NO-ERROR'
    try {
      validateAbiManifest(copy, CONTRACT)
    } catch (error) {
      actual = String(error && error.message ? error.message : error)
    }
    const pass = actual.startsWith(expected)
    cases.push({ name, pass, expected, actual })
    if (!pass) throw new Error(`${name}: expected ${expected}, got ${actual}`)
  }

  const result = { ok: true, checkedAt: new Date().toISOString(), cases }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'engine-registry-negative.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
