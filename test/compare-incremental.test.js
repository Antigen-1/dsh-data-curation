import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doCompare, doContract, doInit, doSubmit, doVerify } from '../lib/core.js'

async function makeProject(records = ['CASE-0001', 'CASE-0002']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-inc-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 A区\nCASE-0002 B区\n', 'utf8')
  return root
}

const contractOf = (records) => ({
  fields: [
    { name: 'location', allowEmpty: false },
    { name: 'note', allowEmpty: true, requireEvidence: false },
  ],
  records: { kind: 'list', values: records },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  gates: { minAcceptedRatio: 0 },
})

async function submitBoth(root, record, values) {
  // The project lock is exclusive, so submissions must be sequential.
  const first = await doSubmit({
    cwd: root, channel: 'text', batch: 'B001',
    records: [{ record_id: record, status: 'valid', values, evidence: { location: { page: 1 } } }],
  })
  const second = await doSubmit({
    cwd: root, channel: 'vision', batch: 'B001',
    records: [{ record_id: record, status: 'valid', values, evidence: { location: { page: 1 } } }],
  })
  return [first, second]
}

async function prepared() {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  assert.equal((await doContract({ cwd: root, contract: contractOf(['CASE-0001', 'CASE-0002']) })).ok, true)
  for (const record of ['CASE-0001', 'CASE-0002']) {
    const [a, b] = await submitBoth(root, record, { location: 'A区', note: '' })
    assert.equal(a.ok, true, a.error)
    assert.equal(b.ok, true, b.error)
  }
  return root
}

test('首批没有历史运行 → 全量，scope 记为 all', async () => {
  const root = await prepared()
  const first = await doCompare({ cwd: root })
  assert.equal(first.ok, true)
  assert.equal(first.scope, 'all')
  assert.equal(first.recomputed, 4)
  assert.equal(first.skippedCells, 0)
})

test('只改一格 → 增量只重判这一格', async () => {
  const root = await prepared()
  assert.equal((await doCompare({ cwd: root })).ok, true)
  assert.equal((await doSubmit({
    cwd: root, channel: 'vision', batch: 'B002',
    records: [{ record_id: 'CASE-0001', status: 'valid', values: { location: 'A区', note: '' }, evidence: { location: { page: 2 } } }],
  })).ok, true)
  const second = await doCompare({ cwd: root })
  assert.equal(second.ok, true)
  assert.equal(second.scope, 'auto')
  assert.equal(second.recomputed, 2)
  assert.equal(second.skippedCells, 2)
})

test('没有新提交时直接跳过，不写 decision', async () => {
  const root = await prepared()
  assert.equal((await doCompare({ cwd: root })).ok, true)
  const again = await doCompare({ cwd: root })
  assert.equal(again.ok, true)
  assert.equal(again.skipped, true)
  assert.equal(again.recomputed, 0)
  assert.equal(again.runId, null)
})

test('scope=all 强制全量重判', async () => {
  const root = await prepared()
  assert.equal((await doCompare({ cwd: root })).ok, true)
  const all = await doCompare({ cwd: root, scope: 'all' })
  assert.equal(all.ok, true)
  assert.equal(all.scope, 'all')
  assert.equal(all.recomputed, 4)
})

test('契约换版后 auto 回到全量（旧结论不可复用）', async () => {
  const root = await prepared()
  assert.equal((await doCompare({ cwd: root })).ok, true)
  const next = contractOf(['CASE-0001', 'CASE-0002'])
  next.fields[1] = { name: 'note', allowEmpty: true, requireEvidence: false }
  next.normalization = { mode: 'strict' }
  const signed = await doContract({ cwd: root, contract: next, force: true })
  assert.equal(signed.ok, true, signed.error)
  const after = await doCompare({ cwd: root })
  assert.equal(after.ok, true)
  assert.equal(after.scope, 'all')
  assert.equal(after.recomputed, 4)
})

test('增量之后覆盖率仍然完整（验收不会因覆盖出洞）', async () => {
  const root = await prepared()
  assert.equal((await doCompare({ cwd: root })).ok, true)
  assert.equal((await doSubmit({
    cwd: root, channel: 'text', batch: 'B003',
    records: [{ record_id: 'CASE-0002', status: 'valid', values: { location: 'B区', note: '' }, evidence: { location: { page: 1 } } }],
  })).ok, true)
  const inc = await doCompare({ cwd: root })
  assert.equal(inc.scope, 'auto')
  const verified = await doVerify({ cwd: root })
  const coverage = verified.checks.find((c) => c.name === 'coverage')
  assert.equal(coverage.status, 'pass')
})

test('非法 scope 被拒绝', async () => {
  const root = await prepared()
  const bad = await doCompare({ cwd: root, scope: 'latest' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /scope/)
})
