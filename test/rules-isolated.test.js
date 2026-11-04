import assert from 'node:assert/strict'
import test from 'node:test'
import { runRuleIsolated } from '../lib/rules/isolated.js'
import { compileSchemeRule } from '../lib/rules/scheme/compile.js'
import { compileRule } from '../lib/rules/compiler.js'

const v = (name) => ['var', name]
const d = (value) => ['datum', value]
const p = (id, ...args) => ['apply', ['primitive', id], args]
const lam = (params, body) => ['lambda', params, body]

test('隔离执行：纯规则返回 JSON 结果', async () => {
  const result = await runRuleIsolated(lam(['x'], p('+', v('x'), d(1))), [41], { timeoutMs: 2000 })
  assert.equal(result, 42)
})

test('隔离执行：失控规则在超时后被终止，不阻塞主线程', async () => {
  const rule = lam(['f'], ['begin',
    ['set!', 'f', lam(['n'], ['apply', v('f'), [p('+', v('n'), d(1))]])],
    ['apply', v('f'), [d(0)]],
  ])
  const started = Date.now()
  await assert.rejects(
    runRuleIsolated(rule, [null], { timeoutMs: 150, limits: { maxFuel: 1e12 } }),
    (error) => error.code === 'TIMEOUT',
  )
  assert.ok(Date.now() - started < 1500)
})

test('隔离执行：纯 Scheme 源码与持久化 AST 身份、行为一致', async () => {
  const source = '(lambda (x) ((conjoin number? (lambda (n) (> n 0))) x))'
  const fromScheme = compileSchemeRule(source)
  const fromAst = compileRule(fromScheme.ast)
  assert.equal(fromScheme.hash, fromAst.hash)
  for (const [input, expected] of [[2, true], [-1, false], ['2', false]]) {
    assert.equal(await runRuleIsolated(source, [input], { scheme: true }), expected)
    assert.equal(await runRuleIsolated(fromScheme.ast, [input]), expected)
  }
})

test('隔离执行：静态错误带 code/path 返回', async () => {
  await assert.rejects(
    runRuleIsolated(lam([], p('no-such-primitive')), [], { timeoutMs: 1000 }),
    (error) => error.code === 'UNKNOWN_PRIMITIVE' && typeof error.path === 'string',
  )
})
