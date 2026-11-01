import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CapabilitySet,
  RuleError,
  RuleRegistry,
  compileRule,
  expandRule,
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
const asyncCode = async (promise, code) => assert.rejects(Promise.resolve(promise), (error) => error instanceof RuleError && error.code === code)

test('let 展开为 lambda application', async () => {
  const rule = lam([], ['let', [['x', d(2)], ['y', d(3)]], p('+', v('x'), v('y'))])
  assert.equal(await runRule(rule, []), 5)
})

test('letrec 支持递归与相互绑定', async () => {
  const fact = lam(['n'], ['if', p('=', v('n'), d(0)), d(1), p('*', v('n'), call(v('fact'), p('-', v('n'), d(1))))])
  const rule = lam([], ['letrec', [['fact', fact]], call(v('fact'), d(5))])
  assert.equal(await runRule(rule, []), 120)

  const even = lam(['n'], ['if', p('=', v('n'), d(0)), d(true), call(v('odd'), p('-', v('n'), d(1)))])
  const odd = lam(['n'], ['if', p('=', v('n'), d(0)), d(false), call(v('even'), p('-', v('n'), d(1)))])
  const mutual = lam([], ['letrec', [['even', even], ['odd', odd]], call(v('even'), d(10))])
  assert.equal(await runRule(mutual, []), true)
})

test('named let 支持循环', async () => {
  const rule = lam([], ['let', 'loop', [['i', d(0)], ['acc', d(0)]],
    ['if', p('=', v('i'), d(5)), v('acc'),
      call(v('loop'), p('+', v('i'), d(1)), p('+', v('acc'), v('i')))],
  ])
  assert.equal(await runRule(rule, []), 10)
})

test('cond 支持 else，且展开结果与手写 if 等价', async () => {
  const rule = lam([], ['cond',
    [p('=', d(1), d(2)), d('no')],
    ['else', d('yes')],
  ])
  const manual = lam([], ['if', p('=', d(1), d(2)), d('no'), d('yes')])
  assert.equal(await runRule(rule, []), await runRule(manual, []))
})

test('高级形式错误：重复绑定、else 位置、坏绑定形状', () => {
  staticCode(() => compileRule(lam([], ['let', [['x', d(1)], ['x', d(2)]], v('x')])), 'DUPLICATE_PARAMETER')
  staticCode(() => compileRule(lam([], ['cond', ['else', d(1)], [d(true), d(2)]])), 'MALFORMED_AST')
  staticCode(() => compileRule(lam([], ['let', [['x']], v('x')])), 'MALFORMED_AST')
})

test('signature 在参数与返回值边界检查', async () => {
  const rule = lam(['x'], p('+', v('x'), d(1)))
  const compiled = compileRule(rule, { signature: { args: ['number'], result: 'number' } })
  assert.equal(await compiled.invoke([2]), 3)
  await asyncCode(compiled.invoke(['2']), 'SIGNATURE_MISMATCH')
  await asyncCode(compiled.invoke([]), 'SIGNATURE_MISMATCH')

  const stringResult = compileRule(lam([], d(1)), { signature: { result: 'string' } })
  await asyncCode(stringResult.invoke([]), 'SIGNATURE_MISMATCH')
  staticCode(() => compileRule(lam([], d(1)), { signature: { result: 'nope' } }), 'INVALID_SIGNATURE')
})

test('RuleRegistry 不可变、内容哈希稳定且带调用诊断', async () => {
  const build = () => {
    const registry = new RuleRegistry()
    registry.define('inc', lam(['x'], p('+', v('x'), d(1))), { version: '2', signature: { args: ['number'], result: 'number' } })
    registry.define('identity', lam(['x'], v('x')))
    return registry.seal()
  }
  const first = build()
  const second = build()
  assert.equal(first.hash(), second.hash())
  assert.equal(first.describe('inc').version, '2')
  assert.equal(await first.call('inc', [2]), 3)
  assert.throws(() => first.define('late', lam([], d(1))), /已封存/)
  await asyncCode(first.call('missing', []), 'UNKNOWN_RULE')

  const broken = first.get('inc')
  assert.ok(Object.isFrozen(broken))
})

test('capability 默认拒绝，显式授予后只访问获准资源', async () => {
  const rule = lam([], p('data.get', d('allowed')))
  const compiled = compileRule(rule)
  await asyncCode(compiled.invoke([]), 'CAPABILITY_DENIED')

  const caps = new CapabilitySet()
    .grant('data', (request) => {
      if (request.key !== 'allowed') throw new Error('denied')
      return { value: 'ok' }
    })
    .seal()
  assert.deepEqual(await compiled.invoke([], { capabilities: caps }), { value: 'ok' })
  assert.equal(await compileRule(lam([], p('capability?', d('data')))).invoke([], { capabilities: caps }), true)
})

test('staged effects 只进 journal，invokeWithEffects 可审计', async () => {
  const rule = lam([], begin(
    p('effects.stage', d({ op: 'write', table: 'summary', key: 'CASE-1' })),
    p('effects.stage', d({ op: 'write', table: 'summary', key: 'CASE-2' })),
  ))
  const caps = new CapabilitySet().grant('effects', () => true).seal()
  const compiled = compileRule(rule)
  await asyncCode(compiled.invoke([]), 'CAPABILITY_DENIED')
  const out = await compiled.invokeWithEffects([], { capabilities: caps })
  assert.equal(out.effects.length, 2)
  assert.equal(out.effects[0].effect.key, 'CASE-1')
  assert.equal(out.effects[1].seq, 2)
})

test('FFI 必须显式声明，调用结果被隔离', async () => {
  const rule = lam([], ['ffi', 'add', d(2), d(3)])
  staticCode(() => compileRule(rule), 'UNKNOWN_FFI')
  const compiled = compileRule(rule, { ffi: { add: (args) => args[0] + args[1] } })
  assert.equal(await compiled.invoke([]), 5)

  await asyncCode(compileRule(lam([], ['ffi', 'boom']), { ffi: { boom: () => { throw new Error('x') } } }).invoke([]), 'FFI_ERROR')
  await asyncCode(compileRule(lam([], ['ffi', 'bad']), { ffi: { bad: () => undefined } }).invoke([]), 'FFI_RESULT')
})

test('DSL 无法直接取得 fs/require/process 等宿主能力', () => {
  for (const id of ['require', 'fs.readFileSync', 'process.env', 'fetch']) {
    staticCode(() => compileRule(lam([], p(id))), 'UNKNOWN_PRIMITIVE')
  }
})

test('expandRule 不改写输入并拒绝未知的 cond 形状', () => {
  const source = lam([], ['let', [['x', d(1)]], v('x')])
  const before = JSON.stringify(source)
  const expanded = expandRule(source)
  assert.equal(JSON.stringify(source), before)
  assert.equal(expanded[2][0], 'apply')
  assert.throws(() => expandRule(lam([], ['cond', [d(true)]])), (error) => error.code === 'MALFORMED_AST')
})
