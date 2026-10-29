import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BAR_LIMIT,
  PROGRESS_EVENT,
  PROGRESS_KEY,
  canonicalProgress,
  emptyProgress,
  normalizeBar,
  normalizePatch,
  reduceProgress,
  registerProgressProjection,
  appendProgressPatch,
} from '../lib/progress.js'

test('normalizeBar 保留合法字段并补默认 status', () => {
  const bar = normalizeBar({ id: 'batch-1', label: ' 第一批 ', value: 3, total: 25, unit: '例' })
  assert.deepEqual(bar, { id: 'batch-1', label: '第一批', value: 3, total: 25, unit: '例', status: 'running' })
})

test('normalizeBar 拒绝缺 id、控制字符、非法数字与未知状态', () => {
  assert.throws(() => normalizeBar({}), /缺少 id/)
  assert.throws(() => normalizeBar({ id: 'a\u0001b' }), /控制字符/)
  assert.throws(() => normalizeBar({ id: 'a', value: '3' }), /必须是有限数字/)
  assert.throws(() => normalizeBar({ id: 'a', percent: 120 }), /percent 必须在 0\.\.100/)
  assert.throws(() => normalizeBar({ id: 'a', total: 0 }), /total 必须大于 0/)
  assert.throws(() => normalizeBar({ id: 'a', status: 'finished' }), /status 必须是/)
})

test('normalizePatch 校验补丁组合', () => {
  assert.deepEqual(normalizePatch({ remove: ['a'] }), { upsert: [], remove: ['a'], clear: false })
  assert.deepEqual(normalizePatch({ clear: true }), { upsert: [], remove: [], clear: true })
  assert.throws(() => normalizePatch({}), /补丁是空的/)
  assert.throws(() => normalizePatch({ clear: true, upsert: [{ id: 'a' }] }), /clear 不能与/)
  assert.throws(() => normalizePatch({ upsert: [{ id: 'a' }, { id: 'a' }] }), /id 重复/)
  const tooMany = Array.from({ length: BAR_LIMIT + 1 }, (_, i) => ({ id: `b${i}` }))
  assert.throws(() => normalizePatch({ upsert: tooMany }), /一次最多/)
})

test('reduceProgress 追加、原位合并、删除与清空', () => {
  let state = emptyProgress()
  assert.equal(reduceProgress(state, {}), state, '空补丁返回同一引用')

  state = reduceProgress(state, { upsert: [{ id: 'a', label: 'A' }], at: '2026-01-01T00:00:00.000Z' })
  state = reduceProgress(state, { upsert: [{ id: 'b', label: 'B' }], at: '2026-01-01T00:00:01.000Z' })
  assert.deepEqual(state.bars.map((bar) => bar.id), ['a', 'b'])

  state = reduceProgress(state, { upsert: [{ id: 'a', value: 4, total: 8 }], at: '2026-01-01T00:00:02.000Z' })
  assert.deepEqual(state.bars.map((bar) => bar.id), ['a', 'b'], '合并保持原位置')
  assert.equal(state.bars[0].label, 'A', '合并保留未提交字段')
  assert.equal(state.bars[0].value, 4)
  assert.equal(state.bars[0].updatedAt, '2026-01-01T00:00:02.000Z')

  state = reduceProgress(state, { remove: ['a'] })
  assert.deepEqual(state.bars.map((bar) => bar.id), ['b'])

  state = reduceProgress(state, { clear: true })
  assert.deepEqual(state.bars, [])
})

test('canonicalProgress 丢弃坏条目并保持规范文档的引用', () => {
  assert.deepEqual(canonicalProgress(null), { bars: [] })
  assert.deepEqual(canonicalProgress({ bars: 'x' }), { bars: [] })
  const good = { bars: [{ id: 'a', status: 'running' }] }
  assert.equal(canonicalProgress(good), good, '规范文档原样返回')
  const dirty = { bars: [{ id: 'a', status: 'running' }, { id: 'a', status: 'running' }, { id: '', status: 'running' }, null] }
  assert.deepEqual(canonicalProgress(dirty).bars.map((bar) => bar.id), ['a'], '重复与非法条目被丢弃')
})

test('registerProgressProjection 投影只折叠自己的事件', () => {
  let definition
  registerProgressProjection({ sessionProjections: { register: (def) => { definition = def } } })
  assert.equal(definition.key, PROGRESS_KEY)
  assert.equal(definition.stateVersion, 1)
  assert.deepEqual(definition.init(), { bars: [] })

  const initial = definition.init()
  const other = { type: 'tool/result', data: {} }
  assert.equal(definition.apply(initial, other), initial, '非本插件事件返回同一引用')

  const folded = definition.apply(initial, {
    type: PROGRESS_EVENT,
    data: { upsert: [{ id: 'a', label: 'A', status: 'running' }], remove: [], clear: false, at: '2026-01-01T00:00:00.000Z' },
  })
  assert.deepEqual(folded.bars.map((bar) => bar.id), ['a'])
  assert.equal(definition.wire.view(folded), folded, 'view 不改写引用')
  assert.deepEqual(definition.wire.viewSchema.parse(folded), folded)
})

test('appendProgressPatch 用 plugin record 事件类型并盖上时间戳', () => {
  const seen = []
  const session = { id: 's-1' }
  const { at } = appendProgressPatch(session, normalizePatch({ upsert: [{ id: 'a', label: 'A' }] }), (target, type, data) => {
    seen.push({ target, type, data })
    return 1
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].target, session)
  assert.equal(seen[0].type, PROGRESS_EVENT)
  assert.match(seen[0].type, /^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u)
  assert.equal(seen[0].data.at, at)
  assert.deepEqual(seen[0].data.upsert.map((bar) => bar.id), ['a'])
})
