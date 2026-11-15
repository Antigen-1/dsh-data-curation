import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const plugin = [
  '(library (dsh plugin builder-plugin (1 0 0))',
  '  (export bump)',
  '  (import (rnrs base (6)))',
  '  (define (bump value) (+ value 1)))',
  '',
].join('\n')

const pluginRule = [
  '(library (dsh rule builder.plugin-rule (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (only (dsh plugin builder-plugin (1 0 0)) bump))',
  '  (define (entry) (bump 41)))',
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

test('buildSchemeV2Pin rejects malformed signatures before emitting a pin', async () => {
  await assert.rejects(
    buildSchemeV2Pin({
      rules: [{
        id: 'builder.rule',
        version: [1, 0, 0],
        source: rule,
        signature: { inputs: [], output: 'not a symbol', variadic: false },
      }],
    }),
    (error) => error.code === 'E-PIN-SIGNATURE',
  )
})

test('buildSchemeV2Pin includes plugins in pin verification and runtime loading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-builder-plugin-'))
  const pluginPath = join(root, 'rules', 'scheme', 'lib', 'dsh', 'plugin', 'builder-plugin', '1.0.0.sls')
  try {
    await mkdir(join(pluginPath, '..'), { recursive: true })
    await writeFile(pluginPath, plugin, 'utf8')
    const pin = await buildSchemeV2Pin({
      project: 'builder-plugin-test',
      rules: [{ id: 'builder.plugin-rule', version: [1, 0, 0], source: pluginRule }],
      plugins: [{
        id: 'builder-plugin',
        version: [1, 0, 0],
        kind: 'library',
        source: plugin,
        exports: ['bump'],
      }],
    })
    assert.match(pin.plugins[0].treeHash, /^sha256:[0-9a-f]{64}$/)
    const runtime = await SchemeV2Runtime.open(pin, { projectRoot: root })
    try {
      assert.equal(await runtime.call('builder.plugin-rule'), 42)
      assert.equal(await runtime.callPlugin('builder-plugin', [1, 0, 0], 'bump', [41]), 42)
    } finally {
      await runtime.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
