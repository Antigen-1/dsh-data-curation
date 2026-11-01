import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { doInit, doPin } from '../lib/core.js'
import { validateContract } from '../lib/contract.js'
import {
  DEFAULT_PIN_RULES, applyPinRules, mergeTable, pinHash, validatePin,
} from '../lib/pin.js'

const v = (name) => ['var', name]
const d = (value) => ['datum', value]
const p = (id, ...args) => ['apply', ['primitive', id], args]
const lam = (params, body) => ['lambda', params, body]

const basePin = (rules) => ({
  version: 5,
  project: { name: 'rules-demo' },
  defaults: {
    channels: [{ name: 'text' }, { name: 'vision' }],
    gates: { minAcceptedRatio: 0 },
  },
  tables: [{
    table: 'summary',
    key: 'record_id',
    records: { kind: 'list', values: ['CASE-1'] },
    fields: [{ name: 'a' }],
  }],
  ...(rules ? { rules } : {}),
})

const mergeWithGates = (ratio) => lam(['input'], p(
  'object-set',
  p('pin.merge-table',
    p('object-get', v('input'), d('defaults')),
    p('object-get', v('input'), d('table'))),
  d('gates'),
  d({ minAcceptedRatio: ratio }),
))

const rule = (id, source, signature = { args: ['object'], result: 'object' }) => ({
  id, version: '1', source, signature,
})

test('默认 pin 规则与原生 mergeTable 等价，且规则哈希进入 pin', async () => {
  const check = validatePin(basePin(DEFAULT_PIN_RULES))
  assert.equal(check.ok, true, JSON.stringify(check.errors))
  const applied = await applyPinRules(check)
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.deepEqual(applied.check.tables[0].effective, validateContract(mergeTable(check.defaults, check.tables[0].declared)).contract)
  assert.equal(applied.check.tables[0].sources.mergeRule, 'pin.default.merge')
  assert.match(check.pin.rules.merge.hash, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(pinHash(check.pin), pinHash(basePin()))
})

test('自定义 merge 规则可改变领域默认值并保留 provenance', async () => {
  const check = validatePin(basePin({
    version: 1,
    merge: rule('custom.merge', mergeWithGates(0.42)),
  }))
  assert.equal(check.ok, true, JSON.stringify(check.errors))
  const applied = await applyPinRules(check)
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.equal(applied.check.tables[0].effective.gates.minAcceptedRatio, 0.42)
  assert.equal(applied.check.tables[0].sources.mergeRule, 'custom.merge')
  assert.equal(applied.check.ruleRefs[0].id, 'custom.merge')
})

test('修改规则 AST 或签名会改变规则哈希与 pin 封印', () => {
  const one = validatePin(basePin({ version: 1, merge: rule('m', mergeWithGates(0.1)) }))
  const two = validatePin(basePin({ version: 1, merge: rule('m', mergeWithGates(0.2)) }))
  assert.equal(one.ok && two.ok, true)
  assert.notEqual(one.pin.rules.merge.hash, two.pin.rules.merge.hash)
  assert.notEqual(pinHash(one.pin), pinHash(two.pin))

  const signed = validatePin(basePin({
    version: 1,
    merge: rule('m', mergeWithGates(0.1), { args: ['object'], result: 'json' }),
  }))
  assert.equal(signed.ok, true)
  assert.notEqual(signed.pin.rules.merge.hash, one.pin.rules.merge.hash)
})

test('自定义 validate 返回错误时阻断签署', async () => {
  const check = validatePin(basePin({
    version: 1,
    validate: rule('custom.validate', lam(['input'], d({ ok: false, errors: ['项目名被规则拒绝'] }))),
  }))
  assert.equal(check.ok, true)
  const applied = await applyPinRules(check)
  assert.equal(applied.ok, false)
  assert.match(applied.errors.join('；'), /custom\.validate：项目名被规则拒绝/)
})

test('自定义 merge 不能改变 delivery/fields/records', async () => {
  const check = validatePin(basePin({
    version: 1,
    merge: rule('bad.merge', lam(['input'], p('object-set',
      p('pin.merge-table',
        p('object-get', v('input'), d('defaults')),
        p('object-get', v('input'), d('table'))),
      d('delivery'), d({ table: 'other', key: 'record_id' })))),
  }))
  assert.equal(check.ok, true)
  const applied = await applyPinRules(check)
  assert.equal(applied.ok, false)
  assert.match(applied.errors.join('；'), /不能改变 delivery/)
})

test('pin 规则编译错误在 validatePin 阶段返回可读错误', () => {
  const check = validatePin(basePin({
    version: 1,
    merge: rule('bad', ['lambda', ['input'], ['unknown-form']]),
  }))
  assert.equal(check.ok, false)
  assert.match(check.errors.join('；'), /rules\.merge（bad）编译失败/)
})

test('签入后 pin.rules 与 effective 值持久化，事件带规则身份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pin-rules-'))
  try {
    await mkdir(join(root, 'raw'), { recursive: true })
    await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-1 a\n', 'utf8')
    assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
    const pin = basePin({ version: 1, merge: rule('custom.merge', mergeWithGates(0.42)) })
    const dry = await doPin({ cwd: root, pin, dryRun: true })
    assert.equal(dry.ok, true, JSON.stringify(dry))
    const signed = await doPin({ cwd: root, pin })
    assert.equal(signed.ok, true, JSON.stringify(signed))
    assert.equal(signed.hash, dry.hash)
    const db = new DatabaseSync(join(root, '.curation', 'project.sqlite'))
    try {
      const pinRow = db.prepare('SELECT json FROM pin ORDER BY pinned_at DESC LIMIT 1').get()
      const stored = JSON.parse(pinRow.json)
      assert.equal(stored.rules.merge.id, 'custom.merge')
      assert.match(stored.rules.merge.hash, /^sha256:/)
      const table = db.prepare("SELECT json FROM table_pin WHERE table_id = 'summary' ORDER BY revision DESC LIMIT 1").get()
      assert.equal(JSON.parse(table.json).gates.minAcceptedRatio, 0.42)
      const event = db.prepare("SELECT text FROM project_event ORDER BY id DESC LIMIT 1").get()
      assert.match(event.text, /custom\.merge/)
    } finally {
      db.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
