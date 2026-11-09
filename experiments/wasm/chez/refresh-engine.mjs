import { readFileSync, writeFileSync } from 'node:fs'
import { canonicalJson, readDataArchive, sha256Hex } from './pin-v2-lib.mjs'

const root = new URL('.', import.meta.url)
const registryPath = new URL('engine-registry.json', root)
const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
const contract = 'chez-wasm-c-10.4.1-v1'
const entry = registry.engines[contract]
const assets = new URL('10.4.1-c/', root)
const files = []

for (const item of entry.closure) {
  const bytes = readFileSync(new URL(item.path, assets))
  item.sha256 = sha256Hex(bytes)
  item.size = bytes.length
  files.push({ path: item.path, sha256: item.sha256, size: item.size })
}

entry.dataArchive = readDataArchive(
  new URL('scheme-c.js', assets),
  new URL('scheme-c.data', assets),
)
entry.engineArtifactHash = `sha256:${sha256Hex(canonicalJson({ contract, files, dataArchive: entry.dataArchive }))}`
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)

for (const name of ['pin-v2-a.json', 'pin-v2-b.json']) {
  const path = new URL(`pin-v2-fixtures/${name}`, root)
  const pin = JSON.parse(readFileSync(path, 'utf8'))
  pin.engine.engineArtifactHash = entry.engineArtifactHash
  writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`)
}

console.log(entry.engineArtifactHash)
