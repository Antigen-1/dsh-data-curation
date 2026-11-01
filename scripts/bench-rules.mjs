#!/usr/bin/env node
// Micro-benchmark for the adjudication path: native two-channel golden path vs
// a custom decision procedure. This is a local baseline, not a release gate.
import { performance } from 'node:perf_hooks'
import { adjudicate } from '../lib/adjudicate.js'
import { compileDecisionRule } from '../lib/pin-rules.js'

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

const records = Number(process.env.RECORDS ?? 500)
const fields = ['size', 'note']
const recordIds = Array.from({ length: records }, (_, i) => `R${i}`)
const contract = {
  channels: [{ name: 'text' }, { name: 'vision' }],
  fields: fields.map((name) => ({ name, allowEmpty: false })),
  evidence: { required: true },
  adjudication: {},
}
const submissionsByRecord = new Map(recordIds.map((record) => [record, [
  { channel: 'text', status: 'valid', values: Object.fromEntries(fields.map((f) => [f, `${record}-${f}`])), evidence: Object.fromEntries(fields.map((f) => [f, { page: 1, quote: 'x' }])) },
  { channel: 'vision', status: 'valid', values: Object.fromEntries(fields.map((f) => [f, `${record}-${f}`])), evidence: Object.fromEntries(fields.map((f) => [f, { page: 1 }])) },
]]))
const rule = compileDecisionRule({ id: 'bench.accept-first', version: '1', source: acceptFirst, signature: { args: ['object'], result: 'object' } })

async function run(label, decisionRule) {
  for (let i = 0; i < 2; i++) await adjudicate({ contract, recordIds, fields, submissionsByRecord, decisionRule })
  const samples = []
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    const decisions = await adjudicate({ contract, recordIds, fields, submissionsByRecord, decisionRule })
    samples.push(performance.now() - started)
    if (decisions.some((d) => d.status !== 'accepted')) throw new Error(`${label}: unexpected pending`)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  return { label, cells: records * fields.length, medianMs: Number(median.toFixed(1)), msPerCell: Number((median / (records * fields.length)).toFixed(4)) }
}

const native = await run('native', null)
const rules = await run('decision-rule', rule)
console.log(JSON.stringify({ records, fields: fields.length, native, rules, overhead: Number((rules.medianMs / native.medianMs).toFixed(2)) }, null, 2))
