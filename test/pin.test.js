import assert from 'node:assert/strict'
import test from 'node:test'
import { PIN_VERSION, mergeTable, pinHash, validatePin } from '../lib/pin.js'
import example from '../templates/pin.example.json' with { type: 'json' }

const base = () => ({
  version: 5,
  project: { name: 'demo' },
  defaults: {
    channels: [{ name: 'text' }, { name: 'vision' }],
    gates: { minAcceptedRatio: 0 },
  },
  tables: [{
    table: 'out',
    key: 'record_id',
    records: { kind: 'list', values: ['CASE-1'] },
    fields: [{ name: 'a' }],
  }],
})

test('示例 pin 本身合法（v5 + 两层结构）', () => {
  const r = validatePin(example)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.pin.version, PIN_VERSION)
  assert.equal(r.tables.length, 1)
  assert.equal(r.tables[0].effective.delivery.table, 'summary')
  assert.equal(r.tables[0].effective.gates.minAcceptedRatio, 1, '表级 gates 覆盖项目默认')
})

test('v4 契约格式被明确拒绝并提示迁移', () => {
  const r = validatePin({ version: 4, fields: [{ name: 'a' }] })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /v4 契约格式已停用/)
})

test('project 只允许 name 与 description', () => {
  const r = validatePin({ ...base(), project: { name: 'x', owner: 'me' } })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /project 有未知键：owner/)
})

test('表必须显式声明 table/key/records/fields，且表名不能占用状态表', () => {
  const bad = base()
  bad.tables[0] = { ...bad.tables[0], table: 'decision' }
  const r = validatePin(bad)
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /不能占用状态表/)
})

test('表名重复被拒绝', () => {
  const bad = base()
  bad.tables.push({ ...bad.tables[0] })
  const r = validatePin(bad)
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /表名重复/)
})

test('status 只能是 active 或 retired', () => {
  const bad = base()
  bad.tables[0].status = 'paused'
  const r = validatePin(bad)
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /status 只能是 active 或 retired/)
})

test('channels 由 defaults 提供，至少两个且不重名', () => {
  const bad = base()
  bad.defaults.channels = [{ name: 'text' }, { name: 'text' }]
  const r = validatePin(bad)
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /通道名重复/)
})

test('mergeTable：表覆盖 channels 整组替换、synonyms 合并、adjudication 分层替换', () => {
  const effective = mergeTable(
    {
      channels: [{ name: 'text' }, { name: 'vision' }],
      normalization: { mode: 'safe', synonyms: { A: ['a1'] } },
      gates: { minAcceptedRatio: 0.5 },
      adjudication: { compare: { builtin: 'exact' }, select: { builtin: 'first-valid' }, fields: { a: { compare: { builtin: 'numeric' } } } },
    },
    {
      table: 'out',
      key: 'record_id',
      records: { kind: 'list', values: ['CASE-1'] },
      fields: [{ name: 'a' }],
      channels: [{ name: 'ocr' }, { name: 'vision' }],
      normalization: { synonyms: { B: ['b1'] } },
      adjudication: { select: { builtin: 'longest' }, fields: { a: { select: { builtin: 'highest' } } } },
    },
  )
  assert.deepEqual(effective.channels.map((c) => c.name), ['ocr', 'vision'])
  assert.deepEqual(effective.normalization.synonyms, { A: ['a1'], B: ['b1'] })
  assert.equal(effective.adjudication.compare.builtin, 'exact')
  assert.equal(effective.adjudication.select.builtin, 'longest')
  assert.equal(effective.adjudication.fields.a.compare.builtin, 'numeric')
  assert.equal(effective.adjudication.fields.a.select.builtin, 'highest')
  assert.equal(effective.gates.minAcceptedRatio, 0.5)
})

test('pinHash 与表顺序无关、与 undefined 键无关', () => {
  const a = validatePin(base()).pin
  const shuffled = { ...base(), tables: [...base().tables].reverse(), ignored: undefined }
  assert.equal(pinHash(a), pinHash(validatePin(shuffled).pin))
})
