import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPinV2 } from './pin-v2-loader.mjs'
import { createPluginRuntime } from './plugin-runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(HERE, '10.4.1-c')
const OUT_DIR = path.join(HERE, '..', 'results', 'chez', '10.4.1-c')
const OUT = path.join(OUT_DIR, 'cross-side-bundle.json')

const pin = await loadPinV2({
  pinPath: path.join(HERE, 'pin-v2-fixtures', 'pin-v2-a.json'),
  registryPath: path.join(HERE, 'engine-registry.json'),
  assetsRoot: HERE,
})
const moduleSources = [
  readFileSync(path.join(HERE, 'pin-v2-fixtures', 'base.scm'), 'utf8'),
  readFileSync(path.join(HERE, 'pin-v2-fixtures', 'util.scm'), 'utf8'),
]

const runtime = createPluginRuntime({ assetDir: ASSET_DIR })
let pluginBundle
try {
  pluginBundle = await runtime.load(moduleSources)
} finally {
  await runtime.close()
}

const pinBundle = pin.rules[0].bundleHash
assert.equal(pin.ok, true)
assert.equal(pinBundle, pluginBundle)
const result = {
  ok: pin.ok && typeof pinBundle === 'string' && pinBundle === pluginBundle,
  pinBundle,
  pluginBundle,
  module: pin.modules[0].name,
  checkedAt: new Date().toISOString(),
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
assert.equal(pluginBundle, pinBundle)
