import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  doApply, doCompare, doInit, doPin, doSubmit, doVerify,
} from '../lib/core.js'

const v = (name) => ['var', name]
const d = (value) => ['datum', value]
const p = (id, ...args) => ['apply', ['primitive', id], args]
const lam = (params, body) => ['lambda', params, body]
const og = (object, key) => p('object-get', object, key)

// A decision rule that calls an FFI binding to accept the first vote.
const acceptViaFfi = lam(['input'], ['let', [['vote', p('car', og(v('input'), d('votes')))]],
  ['let', [['processed', ['ffi', 'test.process', og(v('vote'), d('raw'))]]],
    p('object-set',
      p('object-set', d({ accepted: true, reason: 'rule.ffi' }),
        d('value'), v('processed')),
      d('adopted'), p('list', og(v('vote'), d('channel'))))]])

const rule = (id, source) => ({ id, version: '1', source, signature: { args: ['object'], result: 'object' } })

function pinOf(decision) {
  return {
    version: 5,
    project: { name: 'ffi-test' },
    defaults: {
      channels: [{ name: 'text' }, { name: 'vision' }],
      evidence: { required: true },
      gates: { minAcceptedRatio: 1 },
    },
    tables: [{
      table: 'summary',
      key: 'record_id',
      records: { kind: 'list', values: ['CASE-1'] },
      fields: [{ name: 'location', allowEmpty: false }],
    }],
    rules: { version: 1, decision },
  }
}

test('pin 规则可以使用 FFI binding（通过模块定义加载）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ffi-test-'))
  try {
    // Create a simple FFI module that uppercases strings.
    await mkdir(join(root, 'ffi'), { recursive: true })
    await writeFile(join(root, 'ffi', 'processor.mjs'), `
export function process(value) {
  return typeof value === 'string' ? value.toUpperCase() : value
}
`, 'utf8')
    await mkdir(join(root, 'raw'), { recursive: true })
    await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-1 location a\n', 'utf8')
    assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)

    // Sign pin with FFI module definition.
    const signed = await doPin({
      cwd: root,
      pin: pinOf(rule('accept.ffi', acceptViaFfi)),
      ffi: {
        'test.process': { module: './ffi/processor.mjs', export: 'process', arity: 1 },
      },
    })
    assert.equal(signed.ok, true, JSON.stringify(signed))

    // Submit and compare.
    const submitted = await doSubmit({
      cwd: root,
      channel: 'text',
      batch: 'B1',
      records: [{ record_id: 'CASE-1', status: 'valid', values: { location: 'a区' }, evidence: { location: { page: 1, quote: 'a' } } }],
    })
    assert.equal(submitted.ok, true, JSON.stringify(submitted))

    const compared = await doCompare({ cwd: root })
    assert.equal(compared.ok, true, JSON.stringify(compared))
    assert.equal(compared.accepted, 1)

    // Apply and verify.
    const applied = await doApply({ cwd: root })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const verified = await doVerify({ cwd: root })
    assert.equal(verified.status, 'PASS', JSON.stringify(verified.checks))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pin 的 rules.ffi 存储完整的模块定义，compare 阶段自动重新加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ffi-test-'))
  try {
    await mkdir(join(root, 'ffi'), { recursive: true })
    await writeFile(join(root, 'ffi', 'processor.mjs'), `
export function process(value) {
  return typeof value === 'string' ? value.toUpperCase() : value
}
`, 'utf8')
    await mkdir(join(root, 'raw'), { recursive: true })
    await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-1 location a\n', 'utf8')
    assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)

    const signed = await doPin({
      cwd: root,
      pin: pinOf(rule('accept.ffi', acceptViaFfi)),
      ffi: {
        'test.process': { module: './ffi/processor.mjs', export: 'process', arity: 1 },
      },
    })
    assert.equal(signed.ok, true, JSON.stringify(signed))

    // Check that pin.rules.ffi contains the module definition.
    const { createStore } = await import('../lib/store.js')
    const store = createStore(root, '.curation')
    const record = await store.readPinRecord()
    const ffiDefs = record.pin.rules.ffi
    assert.ok(Array.isArray(ffiDefs))
    const processDef = ffiDefs.find((def) => def.id === 'test.process')
    assert.ok(processDef)
    assert.equal(processDef.module, './ffi/processor.mjs')
    assert.equal(processDef.export, 'process')
    assert.equal(processDef.arity, 1)

    // Compare should reload FFI from pin's stored definitions.
    const submitted = await doSubmit({
      cwd: root,
      channel: 'text',
      batch: 'B1',
      records: [{ record_id: 'CASE-1', status: 'valid', values: { location: 'a区' }, evidence: { location: { page: 1 } } }],
    })
    assert.equal(submitted.ok, true, JSON.stringify(submitted))
    const compared = await doCompare({ cwd: root })
    assert.equal(compared.ok, true, JSON.stringify(compared))
    assert.equal(compared.accepted, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
