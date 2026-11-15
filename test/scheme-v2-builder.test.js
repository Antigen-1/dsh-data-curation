import assert from 'node:assert/strict'
import test from 'node:test'
import { SchemeV2Runtime, buildSchemeV2Pin, hashSchemeSource } from '../lib/rules/index.js'

const base = [
  '(library (dsh lib base (1 0 0))',
  '  (export two)',
  '  (import (rnrs base (6)))',
  '  (define (two) 2))',
  '',
].join('\n')

const rule = [
  '(library (dsh rule builder.rule (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (only (dsh lib base (1 0 0)) two))',
  '  (define (entry) (two)))',
  '',
].join('\n')

test('buildSchemeV2Pin hashes sources and produces a runnable pin', async () => {
  const pin = await buildSchemeV2Pin({
    project: 'builder-test',
    modules: [{ id: 'base', version: [1, 0, 0], source: base }],
    rules: [{
      id: 'builder.rule',
      version: [1, 0, 0],
      source: rule,
      signature: { inputs: [], output: 'number', variadic: false },
    }],
  })
  assert.equal(pin.schema, 'dsh-pin/v2')
  assert.equal(pin.modules[0].name, '(dsh lib base (1 0 0))')
  assert.match(pin.rules[0].treeHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(pin.rules[0].treeHash, await hashSchemeSource(rule))

  const runtime = await SchemeV2Runtime.open(pin)
  try {
    assert.equal(await runtime.call('builder.rule'), 2)
  } finally {
    await runtime.close()
  }
})
