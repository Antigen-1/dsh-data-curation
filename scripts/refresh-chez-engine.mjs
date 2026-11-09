import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { canonicalJson, readDataArchive, sha256Hex } from '../lib/rules/scheme/v2/pin-lib.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registryPath = join(root, 'assets', 'chez-wasm', 'engine-registry.json')
const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
const contract = 'chez-wasm-c-10.4.1-v1'
const entry = registry.engines[contract]
if (!entry) throw new Error(`missing engine ${contract}`)
const assetsDir = join(root, 'assets', 'chez-wasm', entry.assetsDir)
const files = []

for (const item of entry.closure) {
  const bytes = readFileSync(join(assetsDir, item.path))
  item.sha256 = sha256Hex(bytes)
  item.size = bytes.length
  files.push({ path: item.path, sha256: item.sha256, size: item.size })
}

entry.dataArchive = readDataArchive(
  join(assetsDir, 'scheme-c.js'),
  join(assetsDir, 'scheme-c.data'),
)
entry.engineArtifactHash = `sha256:${sha256Hex(canonicalJson({ contract, files, dataArchive: entry.dataArchive }))}`
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)

const sums = files
  .map((file) => `${file.sha256}  assets/chez-wasm/${entry.assetsDir}/${file.path}`)
  .join('\n')
writeFileSync(join(root, 'assets', 'SHA256SUMS'), `${sums}\n`)

const fixturePath = join(root, 'test', 'fixtures', 'scheme-v2', 'pin-v2-a.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
fixture.engine.engineArtifactHash = entry.engineArtifactHash
writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)

console.log(entry.engineArtifactHash)
