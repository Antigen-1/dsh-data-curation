// Adjudication strategies: agreement is policy, and policy failures are visible.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decideCell, summarize } from '../lib/adjudicate.js'
import { validateContract } from '../lib/contract.js'

const field = { name: 'size', type: 'text', allowEmpty: true, requireEvidence: false }

function contractOf(adjudication) {
  const r = validateContract({
    fields: [{ name: 'size', type: 'text', allowEmpty: true, requireEvidence: false }],
    records: { kind: 'list', values: ['CASE-1'] },
    delivery: { table: 'out', key: 'record_id' },
    channels: [{ name: 'text' }, { name: 'vision' }, { name: 'ocr' }],
    ...(adjudication ? { adjudication } : {}),
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  return r.contract
}

const votes = (pairs) => pairs.map(([channel, value]) => ({
  channel,
  status: 'valid',
  values: { size: value },
  evidence: { size: { page: 1, quote: String(value) } },
}))

const decide = (contract, pairs, root) => decideCell({
  contract, field: contract.fields[0], recordId: 'CASE-1', submissions: votes(pairs), root,
})

function tmpProject() {
  return mkdtempSync(join(tmpdir(), 'curation-strategy-'))
}

function script(dir, name, body) {
  const path = join(dir, name)
  writeFileSync(path, body, 'utf8')
  return path
}

test('默认策略：两个通道归一化后一致即接受', () => {
  const contract = contractOf()
  const d = decide(contract, [['text', '1.2cm'], ['vision', '12mm']])
  assert.equal(d.status, 'accepted')
  assert.equal(d.value, '1.2cm')
  assert.deepEqual(d.adopted, ['text', 'vision'])
  assert.equal(d.synthesized, false)
})

test('两个通道不一致且无第三方：待裁定，不猜', () => {
  const contract = contractOf()
  const d = decide(contract, [['text', '3cm'], ['vision', '5cm']])
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'no_two_channel_agreement')
})

test('numeric + tolerance 让 1.2 与 1.3 视为一致', () => {
  const contract = contractOf({ fields: { size: { compare: { builtin: 'numeric', tolerance: 0.5 } } } })
  const d = decide(contract, [['text', '1.2'], ['vision', '1.3']])
  assert.equal(d.status, 'accepted')
})

test('ordered-groups 允许顺序不同的同一组值，并标记为合成值', () => {
  const contract = contractOf({ fields: { size: { compare: { builtin: 'ordered-groups' } } } })
  const d = decide(contract, [['text', 'A、B'], ['vision', 'B、A']])
  assert.equal(d.status, 'accepted')
  assert.equal(d.synthesized, true)
  assert.equal(d.value, 'A、B')
})

test('select longest 取更长的原文（比较通过后再选写法）', () => {
  const contract = contractOf({ select: { builtin: 'longest' } })
  const d = decide(contract, [['text', '1.2 cm'], ['vision', '12mm']])
  assert.equal(d.status, 'accepted')
  assert.equal(d.value, '1.2 cm')
})

test('select channel-order 按显式顺序取原文', () => {
  const contract = contractOf({ select: { builtin: 'channel-order', order: ['vision', 'text'] } })
  const d = decide(contract, [['text', '1.2cm'], ['vision', '12mm']])
  assert.equal(d.status, 'accepted')
  assert.equal(d.value, '12mm')
  assert.deepEqual(d.adopted, ['text', 'vision'])
})

test('select lowest/highest 按数值取，非数字时明确失败', () => {
  // 先让比较通过（numeric 容差放宽），再由 select 决定写哪个写法
  const lowC = { compare: { builtin: 'numeric', tolerance: 10 }, fields: { size: { select: { builtin: 'lowest' } } } }
  const lowest = contractOf(lowC)
  assert.equal(decide(lowest, [['text', '2'], ['vision', '5']]).value, '2')

  const highC = { compare: { builtin: 'numeric', tolerance: 10 }, fields: { size: { select: { builtin: 'highest' } } } }
  const highest = contractOf(highC)
  assert.equal(decide(highest, [['text', '2'], ['vision', '5']]).value, '5')

  const bad = decide(lowest, [['text', '两处'], ['vision', '两处']])
  assert.equal(bad.status, 'pending')
  assert.equal(bad.reason, 'adjudicator_invalid')
})

test('外部 compare 命令：输出 groups 即按它分组', () => {
  const dir = tmpProject()
  script(dir, 'compare.mjs', `
    let input = ''
    process.stdin.on('data', (d) => { input += d })
    process.stdin.on('end', () => {
      const payload = JSON.parse(input)
      // group by first character, so "A区" and "A段" agree under project policy
      const buckets = new Map()
      payload.values.forEach((v, i) => {
        const key = String(v.normalized).slice(0, 1)
        buckets.set(key, [...(buckets.get(key) ?? []), i])
      })
      process.stdout.write(JSON.stringify({ groups: [...buckets.values()] }))
    })
  `)
  const contract = contractOf({ compare: { command: 'node compare.mjs' } })
  const d = decide(contract, [['text', 'A区'], ['vision', 'A段']], dir)
  assert.equal(d.status, 'accepted')
  assert.equal(d.strategy.compare, 'command')
})

test('外部 compare 命令失败：待裁定，且原因写明退出码', () => {
  const dir = tmpProject()
  script(dir, 'fail.mjs', `process.stderr.write('policy rejected'); process.exit(3)`)
  const contract = contractOf({ compare: { command: 'node fail.mjs' } })
  const d = decide(contract, [['text', 'A'], ['vision', 'A']], dir)
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'adjudicator_error')
  assert.ok(d.detail.includes('退出码 3'))
})

test('外部 compare 命令输出格式不对：待裁定，不采信', () => {
  const dir = tmpProject()
  script(dir, 'bad.mjs', `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{"nope":1}'))`)
  const contract = contractOf({ compare: { command: 'node bad.mjs' } })
  const d = decide(contract, [['text', 'A'], ['vision', 'A']], dir)
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'adjudicator_error')
  assert.ok(d.detail.includes('groups'))
})

test('外部 select 命令可返回下标，也可返回自定义值（标记为合成）', () => {
  const dir = tmpProject()
  script(dir, 'pick-index.mjs', `
    let input = ''
    process.stdin.on('data', (d) => { input += d })
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({ index: 1 })))
  `)
  const byIndex = contractOf({ select: { command: 'node pick-index.mjs' } })
  const d1 = decide(byIndex, [['text', '1.2cm'], ['vision', '12mm']], dir)
  assert.equal(d1.status, 'accepted')
  assert.equal(d1.value, '12mm')
  assert.equal(d1.synthesized, false)

  script(dir, 'pick-value.mjs', `
    process.stdin.resume()
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({ value: '1.2cm/12mm' })))
  `)
  const byValue = contractOf({ select: { command: 'node pick-value.mjs' } })
  const d2 = decide(byValue, [['text', '1.2cm'], ['vision', '12mm']], dir)
  assert.equal(d2.status, 'accepted')
  assert.equal(d2.value, '1.2cm/12mm')
  assert.equal(d2.synthesized, true)
})

test('策略名进入决策记录，便于事后审计', () => {
  const contract = contractOf({ compare: { builtin: 'numeric' }, select: { builtin: 'longest' } })
  const d = decide(contract, [['text', '1'], ['vision', '1']])
  assert.deepEqual(d.strategy, { compare: 'numeric', select: 'longest' })
})

test('summarize 统计合成值与待裁定原因', () => {
  const contract = contractOf({ fields: { size: { compare: { builtin: 'ordered-groups' } } } })
  const decisions = [
    decide(contract, [['text', 'A、B'], ['vision', 'B、A']]),
    decide(contract, [['text', 'x'], ['vision', 'y']]),
  ]
  const s = summarize(decisions)
  assert.equal(s.total, 2)
  assert.equal(s.accepted, 1)
  assert.equal(s.synthesized, 1)
  assert.equal(s.byReason.no_two_channel_agreement, 1)
})
