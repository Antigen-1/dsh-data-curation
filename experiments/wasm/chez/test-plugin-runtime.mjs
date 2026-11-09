import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginRuntime } from './plugin-runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(HERE, '10.4.1-c')
const OUT = path.join(HERE, '..', 'results', 'chez', '10.4.1-c', 'plugin-runtime.json')

const GOOD = `(library (dsh plugin demo v1)
  (export answer)
  (import (rnrs base (6)))
  (define (answer) 42))`

const FRESH = `(library (dsh plugin fresh v1)
  (export answer)
  (import (rnrs base (6)))
  (define (answer) 7))`

const UTIL = `(library (dsh lib util v1)
  (export seven)
  (import (rnrs base (6)))
  (define (seven) 7))`

const IMPORTER = `(library (dsh plugin imported v1)
  (export answer)
  (import (rnrs base (6)) (dsh lib util v1))
  (define (answer) (seven)))`

const VERSIONED_V1 = `(library (dsh lib versioned v1)
  (export value)
  (import (rnrs base (6)))
  (define (value) 1))`

const VERSIONED_V2 = `(library (dsh lib versioned v2)
  (export value)
  (import (rnrs base (6)))
  (define (value) 2))`

const MISSING_EXPORT = `(library (dsh plugin missing v1)
  (export missing)
  (import (rnrs base (6)))
  (define (answer) 1))`

const checks = []
function check (name, fn) {
  return Promise.resolve().then(fn).then(
    () => checks.push({ name, ok: true }),
    (error) => {
      checks.push({ name, ok: false, error: error.message, code: error.code || null })
      throw error
    },
  )
}

const runtime = createPluginRuntime({ assetDir: ASSET_DIR })
try {
  await check('load-good', async () => {
    const pluginBundle = await runtime.load([GOOD])
    assert.equal(await runtime.count(), 1)
    assert.equal(await runtime.present(['dsh', 'plugin', 'demo', 'v1']), true)
    assert.equal(await runtime.pinBundle(), pluginBundle)

    const importedBundle = await runtime.load([UTIL, IMPORTER])
    assert.notEqual(importedBundle, pluginBundle)
    assert.equal(await runtime.pinBundle(), importedBundle)

    const firstVersion = await runtime.load([VERSIONED_V1])
    assert.equal(await runtime.pinBundle(), firstVersion)
    const secondVersion = await runtime.load([VERSIONED_V2])
    assert.notEqual(secondVersion, firstVersion)
    assert.equal(await runtime.pinBundle(), secondVersion)
  })

  await check('failed-load-auto-restarts-and-clears-global-library', async () => {
    await assert.rejects(
      runtime.load([FRESH, MISSING_EXPORT]),
      (error) => error.code === 'E-EXPORT-MISSING',
    )
    assert.equal(await runtime.count(), 2)
    assert.equal(await runtime.present(['dsh', 'plugin', 'demo', 'v1']), true)
    assert.equal(await runtime.present(['dsh', 'plugin', 'imported', 'v1']), true)
    // The failed source was never committed and cannot survive the restart.
    assert.equal(await runtime.present(['dsh', 'plugin', 'fresh', 'v1']), false)
  })

  await check('restart-replays-committed-bundles', async () => {
    await runtime.restart()
    assert.equal(await runtime.count(), 2)
    assert.equal(await runtime.present(['dsh', 'plugin', 'demo', 'v1']), true)
    assert.equal(await runtime.present(['dsh', 'plugin', 'imported', 'v1']), true)
    assert.equal(await runtime.present(['dsh', 'lib', 'versioned', 'v2']), true)
    assert.equal(await runtime.present(['dsh', 'plugin', 'fresh', 'v1']), false)
  })

  await check('load-or-restart-recovers-automatically', async () => {
    await assert.rejects(
      runtime.loadOrRestart([MISSING_EXPORT]),
      (error) => error.code === 'E-EXPORT-MISSING',
    )
    assert.equal(await runtime.count(), 2)
    assert.equal(await runtime.present(['dsh', 'plugin', 'fresh', 'v1']), false)
  })
} finally {
  await runtime.close()
  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({
    ok: checks.every((c) => c.ok),
    checkedAt: new Date().toISOString(),
    checks,
  }, null, 2) + '\n')
}

console.log(JSON.stringify({ ok: true, checks }, null, 2))
