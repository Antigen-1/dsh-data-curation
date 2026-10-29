import assert from 'node:assert/strict'
import test from 'node:test'
import { expandSynonyms, normalizeValue, specFor } from '../lib/normalize.js'

const safe = { mode: 'safe' }

test('全半角、空白与标点被归一化', () => {
  assert.equal(normalizeValue('  Ａ区　大小 1.5cm ', safe), 'A区 大小 15mm')
  assert.equal(normalizeValue('区域甲，表面（完整）', safe), '区域甲,表面(完整)')
})

test('明确的 cm/mm 换算后一致', () => {
  assert.equal(normalizeValue('1.2cm', safe), normalizeValue('12mm', safe))
  assert.equal(normalizeValue('12 毫米', safe), '12mm')
})

test('中文数量词在计数语境下换算', () => {
  assert.equal(normalizeValue('两处', safe), normalizeValue('2处', safe))
  assert.equal(normalizeValue('三枚', safe), '3枚')
  assert.equal(normalizeValue('一侧壁', safe), '一侧壁')
})

test('strict 模式不做单位与数量词换算', () => {
  assert.notEqual(normalizeValue('1.2cm', { mode: 'strict' }), normalizeValue('12mm', { mode: 'strict' }))
})

test('同义词按别名→规范值精确匹配', () => {
  const spec = { mode: 'safe', synonyms: { 常规型: '标准型' } }
  assert.equal(normalizeValue('常规型', spec), '标准型')
  assert.equal(normalizeValue('常规型伴增厚', spec), '常规型伴增厚')
})

test('展开契约里的 {规范值: [别名]} 写法', () => {
  assert.deepEqual(expandSynonyms({ 标准型: ['常规型', '普通型'] }), { 常规型: '标准型', 普通型: '标准型' })
  assert.deepEqual(expandSynonyms({ a: 'b' }), { b: 'a' })
})

test('不得把语义不同的值归一成同一个', () => {
  for (const [a, b] of [['完全闭合', '部分闭合'], ['术中出血', '术后出血'], ['区域甲', '区域乙'], ['长径', '短径']]) {
    assert.notEqual(normalizeValue(a, safe), normalizeValue(b, safe), `${a} 与 ${b} 不应相等`)
  }
})

test('specFor 合并全局与字段级设置', () => {
  const contract = { normalization: { mode: 'safe', synonyms: { 标准型: ['常规型'] } } }
  const field = { name: 'f', synonyms: { 标准件: ['常规件'] }, normalize: { caseInsensitive: true } }
  const spec = specFor(contract, field)
  assert.equal(spec.mode, 'safe')
  assert.equal(spec.caseInsensitive, true)
  assert.equal(spec.synonyms['常规型'], '标准型')
  assert.equal(spec.synonyms['常规件'], '标准件')
  assert.equal(normalizeValue('ABC', spec), 'abc')
  assert.equal(normalizeValue('常规型', spec), '标准型')
})
