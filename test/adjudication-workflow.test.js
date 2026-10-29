// End-to-end with a v4 adjudication policy: the contract decides when two
// readings agree, and which spelling the table receives.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { doApply, doCompare, doContract, doInit, doStatus, doSubmit, doVerify } from '../lib/core.js'

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'curation-adj-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 顺序 A、B，大小约 1.5cm\n', 'utf8')
  return root
}

const contractOf = () => ({
  fields: [
    { name: 'order', allowEmpty: false },
    { name: 'measured', type: 'number', allowEmpty: true },
  ],
  records: { kind: 'list', values: ['CASE-0001'] },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  gates: { minAcceptedRatio: 1 },
  adjudication: {
    fields: {
      order: { compare: { builtin: 'ordered-groups' } },
      measured: { compare: { builtin: 'numeric', tolerance: 0.2 }, select: { builtin: 'highest' } },
    },
  },
})

function curatedRow(root) {
  const db = new DatabaseSync(join(root, '.curation', 'project.sqlite'))
  try {
    return db.prepare('SELECT * FROM summary WHERE record_id = ?').get('CASE-0001')
  } finally {
    db.close()
  }
}

test('契约策略生效：顺序不同视为一致，数值按容差与 highest 选取，验收仍 PASS', async () => {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  const signed = await doContract({ cwd: root, contract: contractOf() })
  assert.equal(signed.ok, true, JSON.stringify(signed.errors))

  const submit = (channel, order, measured) => doSubmit({
    cwd: root,
    channel,
    batch: 'B001',
    records: [{
      record_id: 'CASE-0001',
      status: 'valid',
      values: { order, measured },
      evidence: { order: { page: 1, quote: order }, measured: { page: 1, quote: String(measured) } },
    }],
  })
  assert.equal((await submit('text', 'A、B', '1.5')).ok, true)
  assert.equal((await submit('vision', 'B、A', '1.6')).ok, true)

  const compared = await doCompare({ cwd: root })
  assert.equal(compared.ok, true, compared.error)
  assert.equal(compared.accepted, 2)
  assert.equal(compared.pending, 0)
  assert.equal(compared.synthesized, 1)

  const applied = await doApply({ cwd: root })
  assert.equal(applied.ok, true, applied.error)

  const row = curatedRow(root)
  assert.equal(row.order, 'A、B') // 顺序合成，但每个值都来自某个通道
  assert.equal(Number(row.measured), 1.6) // numeric 容差 + highest

  const verified = await doVerify({ cwd: root })
  assert.equal(verified.status, 'PASS', JSON.stringify(verified.checks, null, 2))

  const status = await doStatus({ cwd: root })
  assert.equal(status.decisions.synthesized, 1)
  assert.equal(status.contract.adjudication.fields.order.compare.builtin, 'ordered-groups')
})

test('策略把两通道判为不一致时，落表不动，验收停在 CONDITIONAL', async () => {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  const contract = {
    fields: [{ name: 'order', allowEmpty: false }],
    records: { kind: 'list', values: ['CASE-0001'] },
    delivery: { table: 'summary', key: 'record_id' },
    channels: [{ name: 'text' }, { name: 'vision' }],
    gates: { minAcceptedRatio: 1 },
  }
  assert.equal((await doContract({ cwd: root, contract })).ok, true)

  const submit = (channel, order) => doSubmit({
    cwd: root,
    channel,
    batch: 'B001',
    records: [{ record_id: 'CASE-0001', status: 'valid', values: { order }, evidence: { order: { page: 1 } } }],
  })
  await submit('text', 'A')
  await submit('vision', 'B')

  const compared = await doCompare({ cwd: root })
  assert.equal(compared.accepted, 0)
  assert.equal(compared.byReason.no_two_channel_agreement, 1)
  const applied = await doApply({ cwd: root })
  assert.equal(applied.ok, false)
  assert.ok(applied.error.includes('没有任何被两个通道一致确认'))
  const verified = await doVerify({ cwd: root })
  assert.equal(verified.status, 'FAIL') // 未决格绝不可能验收通过
})
