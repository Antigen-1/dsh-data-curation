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

const acceptFirst = lam(['input'], ['let', [['vote', p('car', og(v('input'), d('votes')))]],
  p('object-set',
    p('object-set', d({ accepted: true, reason: 'rule.single-channel' }),
      d('value'), og(v('vote'), d('raw'))),
    d('adopted'), p('list', og(v('vote'), d('channel'))))])

const rule = (id, source) => ({ id, version: '1', source, signature: { args: ['object'], result: 'object' } })

function pinOf(verifyRule) {
  return {
    version: 5,
    project: { name: 'verify-rules' },
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
    rules: { version: 1, decision: rule('accept.first', acceptFirst), verify: verifyRule },
  }
}

async function signedProject(verifyRule) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verify-rule-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-1 location A\n', 'utf8')
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  const signed = await doPin({ cwd: root, pin: pinOf(verifyRule) })
  assert.equal(signed.ok, true, JSON.stringify(signed))
  const submitted = await doSubmit({
    cwd: root,
    channel: 'text',
    batch: 'B1',
    records: [{ record_id: 'CASE-1', status: 'valid', values: { location: 'A区' }, evidence: { location: { page: 1, quote: 'A' } } }],
  })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  const compared = await doCompare({ cwd: root })
  assert.equal(compared.ok, true, JSON.stringify(compared))
  assert.equal((await doApply({ cwd: root })).ok, true)
  return root
}

test('verify 规则只能追加检查：conditional 会降级状态并留下检查项', async () => {
  const conditional = lam(['input'], d({ checks: [{ name: 'audit', status: 'conditional', detail: '需要人工抽检' }] }))
  const root = await signedProject(rule('audit.conditional', conditional))
  try {
    const out = await doVerify({ cwd: root })
    assert.equal(out.status, 'CONDITIONAL', JSON.stringify(out.checks))
    assert.ok(out.checks.some((c) => c.name === 'rule.audit' && c.status === 'conditional'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verify 规则可显式拒绝，但不会抹掉原生检查', async () => {
  const reject = lam(['input'], d({ ok: false, reason: '不接受当前证据策略' }))
  const root = await signedProject(rule('audit.reject', reject))
  try {
    const out = await doVerify({ cwd: root })
    assert.equal(out.status, 'FAIL', JSON.stringify(out.checks))
    assert.ok(out.checks.some((c) => c.name === 'verify_rule_ok' && c.status === 'fail'))
    assert.ok(out.checks.some((c) => c.name === 'delivery_matches' && c.status === 'pass'))
    assert.ok(out.checks.some((c) => c.name === 'accepted_by_rule' && c.status === 'pass'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verify 规则抛错只增加 FAIL 检查，不影响其它表结构', async () => {
  const boom = lam(['input'], p('error', d('boom')))
  const root = await signedProject(rule('audit.boom', boom))
  try {
    const out = await doVerify({ cwd: root })
    assert.equal(out.status, 'FAIL', JSON.stringify(out.checks))
    assert.ok(out.checks.some((c) => c.name === 'verify_rule' && c.detail.includes('boom')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
