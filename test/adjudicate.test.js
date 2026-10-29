import assert from 'node:assert/strict'
import test from 'node:test'
import { decideCell, summarize } from '../lib/adjudicate.js'

const contract = {
  channels: [{ name: 'text' }, { name: 'vision' }, { name: 'ocr' }, { name: 'manual' }],
  normalization: { mode: 'safe' },
  evidence: { required: true },
}
const field = { name: 'f', allowEmpty: true }

const sub = (channel, raw, { status = 'valid', page = 1 } = {}) => ({
  channel,
  status,
  values: raw === undefined ? {} : { f: raw },
  evidence: page === null ? {} : { f: { page } },
})

test('两个有效通道一致 → 接受', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区'), sub('vision', 'A区')] })
  assert.equal(d.status, 'accepted')
  assert.deepEqual(d.adopted, ['text', 'vision'])
})

test('归一化后一致也算一致，入表用优先通道的原文', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('vision', '12mm'), sub('text', '1.2cm')] })
  assert.equal(d.status, 'accepted')
  assert.equal(d.value, '1.2cm') // 契约里 text 排在 vision 前面
  assert.equal(d.normalized, '12mm')
})

test('只有一个有效通道 → 待裁定', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区'), sub('vision', undefined)] })
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'no_two_channel_agreement')
})

test('uncertain 不计入有效票', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区'), sub('vision', 'A区', { status: 'uncertain' })] })
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'no_two_channel_agreement')
})

test('两个通道分歧 → 待裁定', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区'), sub('vision', 'B区')] })
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'no_two_channel_agreement')
})

test('两通道一致说"未提供" → 接受空白', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', ''), sub('vision', '')] })
  assert.equal(d.status, 'accepted')
  assert.equal(d.value, '')
})

test('不允许空白的字段 → 空白一致也进待裁定', () => {
  const strict = { ...field, allowEmpty: false }
  const d = decideCell({ contract, field: strict, recordId: 'CASE-1', submissions: [sub('text', ''), sub('vision', '')] })
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'empty_not_allowed')
})

test('一致但缺页码/引用 → 待裁定', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区', { page: null }), sub('vision', 'A区', { page: null })] })
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'missing_evidence')
})

test('四个通道两组各两票 → 待裁定 competing_majorities', () => {
  const d = decideCell({
    contract, field, recordId: 'CASE-1',
    submissions: [sub('text', 'A区'), sub('vision', 'A区'), sub('ocr', 'B区'), sub('manual', 'B区')],
  })
  assert.equal(d.status, 'pending')
  assert.equal(d.reason, 'competing_majorities')
})

test('异议被保留，不被多数掩盖', () => {
  const d = decideCell({
    contract, field, recordId: 'CASE-1',
    submissions: [sub('text', 'A区'), sub('vision', 'A区'), sub('ocr', 'B区')],
  })
  assert.equal(d.status, 'accepted')
  assert.deepEqual(d.dissent.map((x) => x.channel), ['ocr'])
})

test('同一通道重复提交只取第一份并留提示', () => {
  const d = decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区'), sub('text', 'B区'), sub('vision', 'A区')] })
  assert.equal(d.status, 'accepted')
  assert.ok(d.notes.some((n) => n.includes('重复')))
})

test('summarize 统计待裁定原因', () => {
  const decisions = [
    decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区'), sub('vision', 'A区')] }),
    decideCell({ contract, field, recordId: 'CASE-1', submissions: [sub('text', 'A区')] }),
  ]
  const s = summarize(decisions)
  assert.equal(s.total, 2)
  assert.equal(s.accepted, 1)
  assert.equal(s.pending, 1)
  assert.equal(s.byReason.no_two_channel_agreement, 1)
})
