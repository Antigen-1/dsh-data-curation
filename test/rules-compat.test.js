import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PIN_RULE_ROLES, PIN_RULES_VERSION,
} from '../lib/pin-rules.js'
import {
  RULE_LANGUAGE_VERSION, compileRule, runRule,
} from '../lib/rules/index.js'
import { CONTRACT_VERSION } from '../lib/contract.js'
import { PIN_VERSION } from '../lib/pin.js'
import { STATE_SCHEMA_VERSION } from '../lib/db.js'
import { createDefaultPrimitives } from '../lib/rules/primitives.js'

test('0.13 稳定语义：语言版本、pin 规则版本与 schema 版本固定', () => {
  assert.equal(RULE_LANGUAGE_VERSION, 1)
  assert.equal(PIN_RULES_VERSION, 1)
  assert.equal(CONTRACT_VERSION, 4)
  assert.equal(PIN_VERSION, 5)
  assert.equal(STATE_SCHEMA_VERSION, 6)
  assert.deepEqual([...PIN_RULE_ROLES], ['validate', 'merge', 'canonicalize', 'decision', 'verify'])
})

test('规则哈希算法冻结：简单规则哈希与 0.13 golden 一致', () => {
  const compiled = compileRule(['lambda', [], ['datum', 1]])
  assert.equal(compiled.hash, 'sha256:cbb288a4bdaff339ec5d48438fac57364666aa115bbcf4271ca68d16acc0efe3')
  assert.equal(compiled.languageVersion, 1)
})

test('0.8 核心形式仍可执行，兼容旧规则源', async () => {
  const source = ['lambda', ['n'], ['let', [['x', ['apply', ['primitive', '+'], [['var', 'n'], ['datum', 1]]]]], ['apply', ['primitive', '*'], [['var', 'x'], ['datum', 2]]]]]
  assert.equal(await runRule(source, [4]), 10)
})

test('默认 primitive 集不暴露文件/网络/进程/模块加载能力', () => {
  const ids = createDefaultPrimitives().ids()
  for (const forbidden of ['fs', 'readFile', 'fetch', 'process', 'require', 'eval', 'child_process']) {
    assert.ok(!ids.includes(forbidden), forbidden)
  }
})
