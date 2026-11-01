import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  doApply, doCompare, doInit, doPin, doStatus, doSubmit, doVerify,
} from '../lib/core.js'

const v = (name) => ['var', name]
const d = (value) => ['datum', value]
const p = (id, ...args) => ['apply', ['primitive', id], args]
const lam = (params, body) => ['lambda', params, body]
const og = (object, key) => p('object-get', object, key)

const acceptFirst = lam(['input'], ['let', [['vote', p('car', og(v('input'), d('votes')))]],
  p('object-set',
    p('object-set', d({ accepted: true, reason: 'rule.single-channel' }),
      d('value'), og(v('vote'), d('raw'))),
    d('adopted'), p('list', og(v('vote'), d('channel'))))])

const rule = (id, source) => ({ id, version: '1', source, signature: { args: ['object'], result: 'object' } })

const pinOf = (records, decision) => ({
  version: 5,
  project: { name: 'decision-rules' },
  defaults: {
    channels: [{ name: 'text' }, { name: 'vision' }],
    evidence: { required: true },
    gates: { minAcceptedRatio: 1 },
  },
  tables: [{
    table: 'summary',
    key: 'record_id',
    records: { kind: 'list', values: records },
    fields: [{ name: 'location', allowEmpty: false }],
  }],
  ...(decision ? { rules: { version: 1, decision } } : {}),
})

async function projectWithPin(pin, records = ['CASE-1']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-decision-rule-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), `${records.join(' ')} location A\n`, 'utf8')
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  const signed = await doPin({ cwd: root, pin })
  assert.equal(signed.ok, true, JSON.stringify(signed))
  return root
}

async function submitText(root, record, value = 'A区') {
  const out = await doSubmit({
    cwd: root,
    channel: 'text',
    batch: 'B1',
    records: [{ record_id: record, status: 'valid', values: { location: value }, evidence: { location: { page: 1, quote: 'A' } } }],
  })
  assert.equal(out.ok, true, JSON.stringify(out))
}

test('自定义 decision 规则可显式接受单通道，apply/verify 不再硬编码双通道', async () => {
  const root = await projectWithPin(pinOf(['CASE-1'], rule('accept.first', acceptFirst)))
  try {
    await submitText(root, 'CASE-1')
    const compared = await doCompare({ cwd: root })
    assert.equal(compared.ok, true, JSON.stringify(compared))
    assert.equal(compared.accepted, 1)
    const db = new DatabaseSync(join(root, '.curation', 'project.sqlite'))
    try {
      const row = db.prepare('SELECT rule_id, rule_hash, proof, adopted FROM decision').get()
      assert.equal(row.rule_id, 'accept.first')
      assert.match(row.rule_hash, /^sha256:/)
      assert.ok(row.proof)
    } finally {
      db.close()
    }
    const applied = await doApply({ cwd: root })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const verified = await doVerify({ cwd: root })
    assert.equal(verified.status, 'PASS', JSON.stringify(verified.checks))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('自定义 decision 规则要求三通道时，双通道仍 pending', async () => {
  const threeChannels = lam(['input'], d({ accepted: false, reason: 'need_three_channels', detail: '需要三个独立通道' }))
  const root = await projectWithPin(pinOf(['CASE-1'], rule('require.three', threeChannels)))
  try {
    await submitText(root, 'CASE-1')
    const vision = await doSubmit({
      cwd: root,
      channel: 'vision',
      batch: 'B1',
      records: [{ record_id: 'CASE-1', status: 'valid', values: { location: 'A区' }, evidence: { location: { page: 1 } } }],
    })
    assert.equal(vision.ok, true, JSON.stringify(vision))
    const compared = await doCompare({ cwd: root })
    assert.equal(compared.ok, true, JSON.stringify(compared))
    assert.equal(compared.accepted, 0)
    assert.equal(compared.pending, 1)
    assert.equal(compared.byReason.need_three_channels, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('decision 规则抛错只影响该格，其他格照常接受', async () => {
  const pin = pinOf(['CASE-1'])
  pin.tables[0].fields.push({ name: 'note', allowEmpty: true })
  const acceptBody = ['let', [['vote', p('car', og(v('input'), d('votes')))]],
    p('object-set',
      p('object-set', d({ accepted: true, reason: 'rule.single-channel' }),
        d('value'), og(v('vote'), d('raw'))),
      d('adopted'), p('list', og(v('vote'), d('channel'))))]
  const conditional = lam(['input'],
    ['if', p('string=?', og(v('input'), d('field')), d('note')),
      p('error', d('boom')),
      acceptBody])
  pin.rules = { version: 1, decision: rule('conditional.rule', conditional) }
  const root = await projectWithPin(pin)
  try {
    for (const channel of ['text', 'vision']) {
      const out = await doSubmit({
        cwd: root,
        channel,
        batch: 'B1',
        records: [{
          record_id: 'CASE-1',
          status: 'valid',
          values: { location: 'A区', note: 'n' },
          evidence: { location: { page: 1 }, note: { page: 1 } },
        }],
      })
      assert.equal(out.ok, true, JSON.stringify(out))
    }
    const compared = await doCompare({ cwd: root })
    assert.equal(compared.ok, true, JSON.stringify(compared))
    assert.equal(compared.accepted, 1)
    assert.equal(compared.pending, 1)
    assert.equal(compared.byReason.rule_error, 1)
    const status = await doStatus({ cwd: root })
    assert.equal(status.ok, true, JSON.stringify(status))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
