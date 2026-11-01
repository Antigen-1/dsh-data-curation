import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PrimitiveRegistry,
  RuleError,
  compileRule,
  createDefaultPrimitives,
  runRule,
} from '../lib/rules/index.js'

const v = (name) => ['var', name]
const d = (value) => ['datum', value]
const p = (id, ...args) => ['apply', ['primitive', id], args]
const call = (fn, ...args) => ['apply', fn, args]
const lam = (params, body) => ['lambda', params, body]
const begin = (...forms) => ['begin', ...forms]
const set = (name, value) => ['set!', name, value]

const staticCode = (fn, code) => assert.throws(fn, (error) => error instanceof RuleError && error.code === code)

test('核心形式：datum/var/if/apply/primitive 与算术', async () => {
  const rule = lam([], p('+', d(1), p('*', d(2), d(3))))
  assert.equal(await runRule(rule, []), 7)
})

test('begin 顺序执行并返回最后一个值', async () => {
  const rule = lam(['n'], begin(set('n', p('+', v('n'), d(1))), p('*', v('n'), d(2))))
  assert.equal(await runRule(rule, [4]), 10)
})

test('闭包捕获调用时的词法环境', async () => {
  const makeAdder = lam(['x'], lam(['y'], p('+', v('x'), v('y'))))
  const rule = lam([], call(call(makeAdder, d(10)), d(5)))
  assert.equal(await runRule(rule, []), 15)
})

test('set! 只修改本次调用的词法单元，跨调用不泄漏', async () => {
  const rule = lam(['n'], begin(set('n', p('+', v('n'), d(1))), v('n')))
  const compiled = compileRule(rule)
  assert.equal(await compiled.invoke([41]), 42)
  assert.equal(await compiled.invoke([5]), 6)
  assert.equal(await compiled.invoke([5]), 6)
})

test('列表与字符串 primitive', async () => {
  const rule = lam(['xs'], begin(
    set('xs', p('list', d(1), d(2), d(3))),
    p('list',
      p('car', v('xs')),
      p('length', v('xs')),
      p('string-append', d('a'), d('b')),
      p('equal?', p('cdr', v('xs')), p('list', d(2), d(3)))),
  ))
  assert.deepEqual(await runRule(rule, [null]), [1, 3, 'ab', true])
})

test('自尾递归 100000 次不增长 JS 调用栈', async () => {
  const rule = lam(['f'], begin(
    set('f', lam(['n'], ['if', p('=', v('n'), d(0)), d(0), call(v('f'), p('-', v('n'), d(1)))])),
    call(v('f'), d(100000)),
  ))
  assert.equal(await runRule(rule, [null], { limits: { timeoutMs: 30_000 } }), 0)
})

test('相互尾递归 100000 次不增长 JS 调用栈', async () => {
  const rule = lam(['f', 'g'], begin(
    set('f', lam(['n'], ['if', p('=', v('n'), d(0)), d(0), call(v('g'), p('-', v('n'), d(1)))])),
    set('g', lam(['n'], ['if', p('=', v('n'), d(0)), d(1), call(v('f'), p('-', v('n'), d(1)))])),
    call(v('f'), d(100000)),
  ))
  assert.equal(await runRule(rule, [null, null], { limits: { timeoutMs: 30_000 } }), 0)
})

test('非尾递归受调用深度限制，不会无限吃栈', async () => {
  const nonTailF = lam(['n'], ['if',
    p('=', v('n'), d(0)),
    d(0),
    p('+', d(1), call(v('f'), p('-', v('n'), d(1)))),
  ])
  const rule = lam(['f'], begin(set('f', nonTailF), call(v('f'), d(200))))
  await assert.rejects(
    runRule(rule, [null], { limits: { maxCallDepth: 32 } }),
    (error) => error.code === 'DEPTH_LIMIT',
  )
})

test('无限递归受 fuel 限制', async () => {
  const rule = lam(['f'], begin(
    set('f', lam(['n'], call(v('f'), p('+', v('n'), d(1))))),
    call(v('f'), d(0)),
  ))
  await assert.rejects(
    runRule(rule, [null], { limits: { maxFuel: 2000 } }),
    (error) => error.code === 'FUEL_EXHAUSTED',
  )
})

test('异步 primitive 的超时被隔离为 TIMEOUT', async () => {
  const primitives = new PrimitiveRegistry()
    .define('sleep', () => new Promise((resolve) => setTimeout(() => resolve(true), 30)), { arity: 0 })
    .seal()
  const rule = lam([], p('sleep'))
  await assert.rejects(
    runRule(rule, [], { primitives, limits: { timeoutMs: 5 } }),
    (error) => error.code === 'TIMEOUT',
  )
})

test('返回值超过输出预算时报 OUTPUT_LIMIT', async () => {
  const primitives = new PrimitiveRegistry()
    .define('huge', () => 'x'.repeat(32), { arity: 0 })
    .seal()
  const rule = lam([], p('huge'))
  await assert.rejects(
    runRule(rule, [], { primitives, limits: { maxOutputBytes: 8 } }),
    (error) => error.code === 'OUTPUT_LIMIT',
  )
})

test('静态检查：未绑定变量带 JSON path', () => {
  staticCode(() => compileRule(lam([], v('missing'))), 'UNBOUND_VARIABLE')
  try {
    compileRule(lam([], v('missing')))
  } catch (error) {
    assert.equal(error.path, '$[2]')
  }
})

test('静态检查：重复参数、未知原语与直接调用的 arity', () => {
  staticCode(() => compileRule(lam(['x', 'x'], d(1))), 'DUPLICATE_PARAMETER')
  staticCode(() => compileRule(lam([], p('no-such-primitive'))), 'UNKNOWN_PRIMITIVE')
  staticCode(() => compileRule(lam([], ['apply', ['primitive', '-'], []])), 'ARITY_MISMATCH')
  staticCode(() => compileRule(lam([], call(lam(['x'], v('x')), d(1), d(2)))), 'ARITY_MISMATCH')
})

test('静态检查：畸形 AST、非 procedure 根、FFI 与限制', () => {
  staticCode(() => compileRule(['datum', 1]), 'RULE_MUST_BE_PROCEDURE')
  staticCode(() => compileRule(lam([], ['if', d(true)])), 'MALFORMED_AST')
  staticCode(() => compileRule(lam([], ['ffi', 'x'])), 'FFI_UNAVAILABLE')
  staticCode(() => compileRule(lam([], ['datum', Number.NaN])), 'MALFORMED_AST')

  let body = d(0)
  for (let i = 0; i < 8; i++) body = ['if', d(true), body, d(0)]
  staticCode(() => compileRule(lam([], body), { limits: { maxAstDepth: 4 } }), 'AST_LIMIT')
  staticCode(() => compileRule(lam([], ['begin', d(1), d(2), d(3)]), { limits: { maxAstNodes: 4 } }), 'AST_LIMIT')
})

test('运行时：调用非 procedure 与动态 arity 错误', async () => {
  await assert.rejects(
    runRule(lam([], call(d(1))), []),
    (error) => error.code === 'NOT_PROCEDURE',
  )
  const rule = lam([], call(lam(['f'], call(v('f'))), lam(['x'], v('x'))))
  await assert.rejects(
    runRule(rule, []),
    (error) => error.code === 'ARITY_MISMATCH',
  )
})

test('默认 primitive registry 封存后不可再注册', () => {
  const primitives = createDefaultPrimitives()
  assert.throws(() => primitives.define('late', () => 1), /封存/)
  assert.throws(() => primitives.define('+', () => 1), /封存/)
})

test('未封存的 registry 不能编译规则', () => {
  const primitives = new PrimitiveRegistry().define('only', () => 1)
  assert.throws(
    () => compileRule(lam([], p('only')), { primitives }),
    /已封存/,
  )
})

test('包入口 dsh-data-curation/rules 可编译并执行规则', async () => {
  const fromPackage = await import('dsh-data-curation/rules')
  const compiled = fromPackage.compileRule(lam([], d(42)))
  assert.equal(await compiled.invoke([]), 42)
})
