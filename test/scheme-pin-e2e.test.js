import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doApply, doCompare, doInit, doPin, doSubmit, doVerify } from '../lib/core.js'
import { loadSchemeRules } from '../lib/rules/index.js'

const moduleSource = await readFile(new URL('../templates/scheme-decision.scm', import.meta.url), 'utf8')

async function submit(root, channel) {
  const out = await doSubmit({
    cwd: root,
    channel,
    batch: 'B1',
    records: [{
      record_id: 'CASE-1',
      status: 'valid',
      values: { location: 'A区' },
      evidence: { location: { page: 1, quote: 'A' } },
    }],
  })
  assert.equal(out.ok, true, JSON.stringify(out))
}

test('Scheme 注册→pin→compare/apply→verify 真实端到端', async () => {
  const loaded = await loadSchemeRules(moduleSource)
  assert.equal(Array.isArray(loaded.pinRules.decision.source), true)
  assert.equal(typeof loaded.pinRules.decision.source, 'object')

  const root = await mkdtemp(join(tmpdir(), 'dsh-scheme-pin-e2e-'))
  try {
    await mkdir(join(root, 'raw'), { recursive: true })
    await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-1 location A\n', 'utf8')
    assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
    const signed = await doPin({
      cwd: root,
      pin: {
        version: 5,
        project: { name: 'scheme-pin-e2e' },
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
        rules: loaded.pinRules,
      },
    })
    assert.equal(signed.ok, true, JSON.stringify(signed))

    await submit(root, 'text')
    const pending = await doCompare({ cwd: root })
    assert.equal(pending.ok, true, JSON.stringify(pending))
    assert.equal(pending.accepted, 0)
    assert.equal(pending.pending, 1)
    assert.equal(pending.byReason.rule_pending, 1)

    await submit(root, 'vision')
    const accepted = await doCompare({ cwd: root })
    assert.equal(accepted.ok, true, JSON.stringify(accepted))
    assert.equal(accepted.accepted, 1)
    assert.equal(accepted.pending, 0)

    const applied = await doApply({ cwd: root })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const verified = await doVerify({ cwd: root })
    assert.equal(verified.status, 'PASS', JSON.stringify(verified.checks))
    assert.ok(verified.checks.some((check) => check.name === 'rule.scheme_audit' && check.status === 'pass'))
    assert.ok(verified.checks.some((check) => check.name === 'accepted_by_rule' && check.status === 'pass'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
