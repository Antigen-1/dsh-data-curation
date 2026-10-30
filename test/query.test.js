import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doApply, doCompare, doInit, doNote, doQuery, doStatus, doSubmit, storeFor } from '../lib/core.js'
import { doPinCompat as doContract } from './_pin.js'

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-query-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 A区 1.5cm\n', 'utf8')
  return root
}

const contractOf = {
  fields: [
    { name: 'location', allowEmpty: false },
    { name: 'measured_value', type: 'number', allowEmpty: true },
  ],
  records: { kind: 'list', values: ['CASE-0001', 'CASE-0002'] },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  gates: { minAcceptedRatio: 0 },
}

async function prepared() {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  assert.equal((await doContract({ cwd: root, contract: contractOf })).ok, true)
  const submit = (channel, values, record = 'CASE-0001') => doSubmit({
    cwd: root,
    channel,
    batch: 'B001',
    records: [{
      record_id: record,
      status: 'valid',
      values,
      evidence: { location: { page: 1 }, measured_value: { page: 1 } },
    }],
  })
  assert.equal((await submit('text', { location: 'A区', measured_value: '1.5cm' })).ok, true)
  assert.equal((await submit('vision', { location: 'A区', measured_value: '15mm' })).ok, true)
  // CASE-0002 只有一个通道 → 待裁定
  assert.equal((await submit('text', { location: 'B区', measured_value: '' }, 'CASE-0002')).ok, true)
  assert.equal((await doCompare({ cwd: root })).ok, true)
  return root
}

test('counts 与 decision 聚合一致', async () => {
  const root = await prepared()
  const res = await doQuery({ cwd: root, what: 'counts' })
  assert.equal(res.ok, true)
  assert.equal(res.data.decisions.total, 4)
  assert.equal(res.data.decisions.accepted, 2)
  assert.equal(res.data.decisions.pending, 2)
  assert.equal(res.data.decisions.byReason.no_two_channel_agreement, 2)
  assert.equal(res.data.submissions.length, 2)
  assert.equal(res.data.submissions.find((s) => s.channel === 'text').batches, 1)
  assert.equal(res.data.tables[0].table, 'summary')
  assert.equal(res.data.runs.total, 1)
  assert.equal(res.data.applied, null)
})

test('pending 支持 reason / record 过滤与 limit', async () => {
  const root = await prepared()
  const all = await doQuery({ cwd: root, what: 'pending' })
  assert.equal(all.data.length, 2)
  assert.ok(all.data.every((r) => r.reason === 'no_two_channel_agreement'))
  const one = await doQuery({ cwd: root, what: 'pending', record: 'CASE-0002', limit: 1 })
  assert.equal(one.data.length, 1)
  assert.equal(one.data[0].record, 'CASE-0002')
  const none = await doQuery({ cwd: root, what: 'pending', reason: 'missing_evidence' })
  assert.equal(none.data.length, 0)
})

test('cells 返回每格最新结论', async () => {
  const root = await prepared()
  const res = await doQuery({ cwd: root, what: 'cells', status: 'accepted' })
  assert.equal(res.data.length, 2)
  const measured = res.data.find((r) => r.field === 'measured_value')
  assert.equal(measured.value, '1.5cm')
  assert.equal(measured.record, 'CASE-0001')
  assert.equal(measured.synthesized, false)
  assert.deepEqual(measured.adopted, ['text', 'vision'])
})

test('votes 返回逐票原值与证据', async () => {
  const root = await prepared()
  const res = await doQuery({ cwd: root, what: 'votes', record: 'CASE-0001', field: 'measured_value' })
  assert.equal(res.data.found, true)
  assert.equal(res.data.status, 'accepted')
  assert.deepEqual(res.data.votes.map((v) => v.raw), ['1.5cm', '15mm'])
  assert.equal(res.data.votes[0].evidence.page, 1)
})

test('submissions 与 runs 可查', async () => {
  const root = await prepared()
  const subs = await doQuery({ cwd: root, what: 'submissions', channel: 'vision' })
  assert.equal(subs.data.length, 1)
  assert.equal(subs.data[0].fields, 2)
  assert.equal(subs.data[0].table, 'summary')
  const runs = await doQuery({ cwd: root, what: 'runs' })
  assert.equal(runs.data.length, 1)
  assert.equal(runs.data[0].kind, 'compare')
  assert.equal(runs.data[0].table, 'summary')
})

test('schema 列出插件表与 curated 表', async () => {
  const root = await prepared()
  assert.equal((await doApply({ cwd: root })).ok, true)
  const res = await doQuery({ cwd: root, what: 'schema' })
  const names = res.data.map((t) => t.table)
  for (const name of ['decision', 'submission', 'ledger', 'run', 'summary']) assert.ok(names.includes(name), name)
  const decision = res.data.find((t) => t.table === 'decision')
  assert.ok(decision.columns.some((c) => c.name === 'synthesized'))
})

test('参数校验与未建工作区', async () => {
  const root = await prepared()
  const bad = await doQuery({ cwd: root, what: 'nope' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /未知的查询类型/)
  const badLimit = await doQuery({ cwd: root, what: 'cells', limit: -1 })
  assert.equal(badLimit.ok, false)
  assert.match(badLimit.error, /limit/)
  const empty = await mkdtemp(join(tmpdir(), 'dsh-curation-empty-'))
  const missing = await doQuery({ cwd: empty, what: 'counts' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /工作区尚未建立/)
})

test('查询不写库、不加锁', async () => {
  const root = await prepared()
  const store = storeFor(root)
  const before = await doStatus({ cwd: root })
  await doQuery({ cwd: root, what: 'counts' })
  await doQuery({ cwd: root, what: 'cells' })
  const after = await doStatus({ cwd: root })
  assert.equal(after.decisions.total, before.decisions.total)
  assert.equal(after.lock, null)
})

test('meta 返回项目、pin、表登记与导出器', async () => {
  const root = await prepared()
  const res = await doQuery({ cwd: root, what: 'meta' })
  assert.equal(res.ok, true, res.error)
  assert.ok(res.data.project)
  assert.ok(res.data.pin.hash)
  assert.equal(res.data.tables[0].table, 'summary')
  assert.deepEqual(res.data.exporters, [])
  assert.ok(res.data.meta.pin_hash)
})

test('note 追加到项目与表，events 可查', async () => {
  const root = await prepared()
  assert.equal((await doNote({ cwd: root, text: '口径：大小取长径' })).ok, true)
  const t = await doNote({ cwd: root, text: 'summary 表来自审计清单', table: 'summary' })
  assert.equal(t.ok, true, t.error)
  const all = await doQuery({ cwd: root, what: 'events', kind: 'note' })
  assert.ok(all.data.some((e) => e.scope === 'table' && e.table === 'summary' && e.text === 'summary 表来自审计清单'))
  assert.ok(all.data.some((e) => e.scope === 'project' && e.text === '口径：大小取长径'))
  const onlyTable = await doQuery({ cwd: root, what: 'events', table: 'summary', kind: 'note' })
  assert.equal(onlyTable.data.length, 1)
})

test('note 拒绝空内容与未登记的表', async () => {
  const root = await prepared()
  const empty = await doNote({ cwd: root, text: '   ' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /不能为空/)
  const unknown = await doNote({ cwd: root, text: 'x', table: 'nope' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /表未登记/)
})
