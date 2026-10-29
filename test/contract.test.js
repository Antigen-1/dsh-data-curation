import assert from 'node:assert/strict'
import test from 'node:test'
import { contractHash, validateContract } from '../lib/contract.js'
import example from '../templates/contract.example.json' with { type: 'json' }

const base = () => ({
  fields: [{ name: 'a' }],
  records: { kind: 'list', values: ['CASE-1'] },
  delivery: { table: 'out', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
})

test('模板契约本身合法', () => {
  const r = validateContract(example)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.contract.fields.length, 4)
  assert.equal(r.contract.delivery.table, 'summary')
  assert.equal(r.contract.version, 3)
})

test('最少两个通道', () => {
  const c = { ...base(), channels: [{ name: 'text' }] }
  const r = validateContract(c)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('两个通道')))
})

test('字段名重复被拒绝', () => {
  const c = { ...base(), fields: [{ name: 'a' }, { name: 'a' }] }
  const r = validateContract(c)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('重复')))
})

test('delivery 缺失、携带 db 或表名非法都被拒绝', () => {
  const missing = validateContract({ ...base(), delivery: undefined })
  assert.equal(missing.ok, false)

  const withDb = validateContract({ ...base(), delivery: { db: 'delivery/out.sqlite', table: 'out', key: 'record_id' } })
  assert.equal(withDb.ok, false)
  assert.ok(withDb.errors.some((e) => e.includes('已废弃')))

  const reserved = validateContract({ ...base(), delivery: { table: 'meta', key: 'record_id' } })
  assert.equal(reserved.ok, false)
  assert.ok(reserved.errors.some((e) => e.includes('不能占用状态表')))

  const clash = validateContract({ ...base(), delivery: { table: 'out', key: 'a' } })
  assert.equal(clash.ok, false)
  assert.ok(clash.errors.some((e) => e.includes('不能与字段同名')))
})

test('只读源路径与表名同样受约束', () => {
  const absolute = validateContract({ ...base(), records: { kind: 'db', db: '/tmp/x.sqlite', table: 'roster', key: 'record_id' } })
  assert.equal(absolute.ok, false)
  assert.ok(absolute.errors.some((e) => e.includes('相对路径')))

  const reserved = validateContract({ ...base(), records: { kind: 'db', db: 'src/roster.sqlite', table: 'decision', key: 'record_id' } })
  assert.equal(reserved.ok, false)
  assert.ok(reserved.errors.some((e) => e.includes('合法表名')))
})

test('契约里写 exporters 会被引导到 curation_exporter', () => {
  const r = validateContract({ ...base(), exporters: { x: { command: 'true' } } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('curation_exporter')))
})

test('minAcceptedRatio 范围校验', () => {
  const r = validateContract({ ...base(), gates: { minAcceptedRatio: 1.5 } })
  assert.equal(r.ok, false)
})

test('默认值被补齐且哈希稳定', () => {
  const r = validateContract(base())
  assert.equal(r.ok, true)
  assert.equal(r.contract.normalization.mode, 'safe')
  assert.equal(r.contract.evidence.required, true)
  assert.equal(r.contract.gates.minAcceptedRatio, 0)
  const shuffled = { channels: r.contract.channels, delivery: r.contract.delivery, records: r.contract.records, fields: r.contract.fields, version: r.contract.version, gates: r.contract.gates, evidence: r.contract.evidence, normalization: r.contract.normalization }
  assert.equal(contractHash(r.contract), contractHash(shuffled))
})
