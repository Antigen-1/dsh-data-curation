import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SchemeV2Runtime } from '../lib/rules/index.js'

const pluginProjectRoot = fileURLToPath(new URL('./fixtures/scheme-v2/project', import.meta.url))

test('pin plugin tree mismatch keeps the request id and structured details', async () => {
  const pin = JSON.parse(readFileSync(new URL('./fixtures/scheme-v2/pin-v2-plugin-a.json', import.meta.url), 'utf8'))
  pin.plugins[0].treeHash = `sha256:${'0'.repeat(64)}`
  await assert.rejects(
    SchemeV2Runtime.open(pin, { projectRoot: pluginProjectRoot }),
    (error) => {
      assert.equal(error.code, 'E-PIN-VERIFY')
      assert.equal(error.details?.pluginId, 'demo')
      assert.equal(error.details?.path, 'lib/dsh/plugin/demo/1.0.0.sls')
      assert.match(error.details?.expected ?? '', /^(?:sha256:)?[0-9a-f]{64}$/)
      assert.match(error.details?.actual ?? '', /^(?:sha256:)?[0-9a-f]{64}$/)
      assert.notEqual(error.details?.expected, error.details?.actual)
      return true
    },
  )
})
