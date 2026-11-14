import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SchemeV2Runtime } from '../lib/rules/index.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/scheme-v2/', import.meta.url))
const pin = JSON.parse(readFileSync(`${fixtureRoot}pin-v2-a.json`, 'utf8'))

test('gcStats is disabled unless debugGcStats is explicitly enabled', async () => {
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: fileURLToPath(new URL('./fixtures/scheme-v2/project', import.meta.url)),
  })
  try {
    await assert.rejects(runtime.gcStats(5000), (error) => error.code === 'E-DEBUG-DISABLED')
  } finally {
    await runtime.close()
  }
})
