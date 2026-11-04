#!/usr/bin/env node
// Micro-benchmark for the adjudication path: native two-channel golden path vs
// a custom decision procedure. This is a local baseline, not a release gate.
import { performance } from 'node:perf_hooks'
import { adjudicate } from '../lib/adjudicate.js'
import { compileDecisionRule } from '../lib/pin-rules.js'
import { compileSchemePredicate, compileSchemeRule } from '../lib/rules/scheme/compile.js'
import { loadSchemeRules } from '../lib/rules/scheme/module.js'

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
const signature = { args: ['object'], result: 'object' }
const rule = compileDecisionRule({ id: 'bench.accept-first', version: '1', source: acceptFirst, signature })
const schemeSource = `
  (lambda (input)
    ((decision-with
      (lambda (ignored) #t)
      (lambda (input)
        (let ((vote (car (object-get input "votes"))))
          (object
            "value" (object-get vote "raw")
            "adopted" (list (object-get vote "channel"))
            "reason" "rule.single-channel"))))
     input))
`
const compileStarted = performance.now()
const schemeCompiled = compileSchemeRule(schemeSource, { signature })
const schemeCompileMs = performance.now() - compileStarted
const schemeRule = compileDecisionRule({ id: 'bench.scheme-accept-first', version: '1', source: schemeCompiled.ast, signature })

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
const scheme = await run('scheme-rule', schemeRule)

async function measurePredicate(label, compiled, input, callsPerSample = 40) {
  for (let i = 0; i < 3; i++) await compiled.invoke([input])
  const samples = []
  for (let sample = 0; sample < 5; sample++) {
    const started = performance.now()
    for (let call = 0; call < callsPerSample; call++) await compiled.invoke([input])
    samples.push((performance.now() - started) / callsPerSample)
  }
  samples.sort((a, b) => a - b)
  return {
    label,
    astNodes: compiled.nodeCount,
    fuelLimit: compiled.limits.maxFuel,
    medianMsPerCall: Number(samples[2].toFixed(4)),
  }
}

const conjoinSource = `(lambda (x) ((conjoin ${Array(16).fill('number?').join(' ')}) x))`
const disjoinSource = `(lambda (x) ((disjoin ${[...Array(15).fill('(lambda (v) #f)'), 'number?'].join(' ')}) x))`
const conjoin16 = await measurePredicate('conjoin16', compileSchemePredicate(conjoinSource), 1)
const disjoin16 = await measurePredicate('disjoin16', compileSchemePredicate(disjoinSource), 1)
const listOf100 = await measurePredicate(
  'list-of/c100',
  compileSchemePredicate('(lambda (x) ((list-of/c number?) x))'),
  Array.from({ length: 100 }, (_, i) => i),
  20,
)

const registrationSource = `
  (define (rule-id i) (string-append "bench.generated." (number->string i)))
  (let loop ((i 0))
    (if (= i 8) '()
        (begin
          (register-rule! (rule-id i) "1" (lambda (x) (= x i)))
          (loop (+ i 1)))))
`
async function measureRegistration() {
  const samples = []
  let loaded
  for (let sample = 0; sample < 5; sample++) {
    const started = performance.now()
    loaded = await loadSchemeRules(registrationSource)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return {
    rules: loaded.descriptors.length,
    astNodes: loaded.descriptors.reduce((sum, item) => sum + item.compiled.nodeCount, 0),
    fuelLimit: Math.max(...loaded.descriptors.map((item) => item.compiled.limits.maxFuel)),
    medianMs: Number(samples[2].toFixed(2)),
  }
}
const registration = await measureRegistration()

console.log(JSON.stringify({
  records,
  fields: fields.length,
  native,
  rules,
  scheme,
  schemeCompileMs: Number(schemeCompileMs.toFixed(2)),
  combinators: { conjoin16, disjoin16, listOf100 },
  registration,
  overhead: Number((rules.medianMs / native.medianMs).toFixed(2)),
  schemeOverhead: Number((scheme.medianMs / native.medianMs).toFixed(2)),
}, null, 2))
