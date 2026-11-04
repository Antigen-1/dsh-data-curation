// Scheme frontend tests exercise the source -> v1 AST -> compileRule path.
// The source text is not the persisted identity: every assertion about a
// registered rule ultimately goes through the ordinary JSON AST.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FfiRegistry,
  RuleRegistry,
  STANDARD_LIBRARY_SOURCE,
  compileRule,
  compileSchemePredicate,
  compileSchemeRule,
  evaluateSchemeModule,
  loadSchemeRules,
  lowerSchemeRule,
  pinRulesFromDescriptors,
  readScheme,
  registerRule,
  standardLibraryBindings,
} from '../lib/rules/index.js'
import { normalizePinRules } from '../lib/pin-rules.js'

const invoke = async (source, value, options = {}) => compileSchemeRule(source, options).invoke([value])
const compilePredicate = async (source, value) => compileSchemePredicate(source).invoke([value])

test('reader：注释、#;、quote 与 span', () => {
  const { datums } = readScheme(`
    #!r6rs
    ; line
    #| outer #| nested |# |#
    (a 1 #;ignored "x")
    '(1 2)
  `)
  assert.equal(datums.length, 2)
  assert.deepEqual(datums[0].items.map((item) => item.kind), ['symbol', 'number', 'string'])
  assert.equal(datums[0].items[2].value, 'x')
  assert.equal(datums[1].kind, 'list')
  assert.equal(datums[1].items[0].kind, 'symbol')
  assert.equal(datums[1].items[0].value, 'quote')
  assert.equal(datums[1].span.start > 0, true)
  assert.equal(datums[1].items[1].items[0].value, 1)
})

test('reader：拒绝 char/vector/dotted list 与未闭合结构', () => {
  assert.throws(() => readScheme('#\\a'), (err) => err.code === 'SCHEME_READ')
  assert.throws(() => readScheme('#(1 2)'), (err) => err.code === 'SCHEME_READ')
  assert.throws(() => readScheme('(1 . 2)'), (err) => err.code === 'SCHEME_READ')
  assert.throws(() => readScheme('(1 2'), (err) => err.code === 'SCHEME_READ')
  assert.throws(() => readScheme('(1 2 3)', { maxTokens: 2 }), (err) => err.code === 'SCHEME_READ')
  assert.throws(() => readScheme('123', { maxSourceBytes: 2 }), (err) => err.code === 'SCHEME_READ')
  assert.throws(() => readScheme('((1))', { maxDepth: 1 }), (err) => err.code === 'SCHEME_READ')
})

test('R6RS 真值：只有 #f 为假，JSON null 为真', async () => {
  assert.equal(await invoke('(lambda (x) (if x 1 2))', false), 2)
  assert.equal(await invoke('(lambda (x) (if x 1 2))', null), 1)
  assert.equal(await invoke('(lambda (x) (if x 1 2))', 0), 1)
  assert.equal(await invoke('(lambda (x) (if x 1 2))', ''), 1)
  assert.equal(await invoke("(lambda (x) (if '() 1 2))", null), 1)
  assert.equal(await invoke('(lambda (x) (and 1 2))', false), 2)
  assert.equal(await invoke('(lambda (x) (or #f 3))', false), 3)
  assert.equal(await invoke('(lambda (x) (cond (#f 1) (else 2)))', null), 2)
  assert.throws(() => compileSchemeRule('(lambda (x) (cond (#f 1)))'), (err) => err.code === 'SCHEME_SYNTAX')
})

test('and/or 短路、返回操作数值且每个操作数至多执行一次', async () => {
  assert.deepEqual(await invoke(`(lambda (x)
    (let ((n 0))
      (list (or (begin (set! n (+ n 1)) "left") (begin (set! n 99) "right")) n)))`, null), ['left', 1])
  assert.deepEqual(await invoke(`(lambda (x)
    (let ((n 0))
      (list (and (begin (set! n (+ n 1)) #f) (begin (set! n 99) #t)) n)))`, null), [false, 1])
  assert.deepEqual(await invoke(`(lambda (x)
    (let ((n 0))
      (list (and (begin (set! n (+ n 1)) "left") (begin (set! n (+ n 1)) "right")) n)))`, null), ['right', 2])
})

test('not 是严格的 R6RS 谓词，不接受核心的 null 假值扩展', async () => {
  assert.equal(await compilePredicate('(lambda (x) (not #f))', null), true)
  assert.equal(await compilePredicate('(lambda (x) (not %json-null))', null), false)
  assert.equal(await compilePredicate('(lambda (x) (not 1))', null), false)
  assert.equal(await compilePredicate('(lambda (x) (not (quote ())))', null), false)
})

test('let/let*/letrec/named let/set!/cond 与 quote', async () => {
  assert.equal(await invoke('(lambda (x) (let ((a 1) (b 2)) (+ a b)))', null), 3)
  assert.equal(await invoke('(lambda (x) (let* ((a 1) (b (+ a 1))) b))', null), 2)
  assert.equal(await invoke('(lambda (x) (letrec ((f (lambda (n) (if (= n 0) 1 (* n (f (- n 1))))))) (f x)))', 5), 120)
  assert.equal(await invoke('(lambda (x) (let loop ((n x) (acc 1)) (if (= n 0) acc (loop (- n 1) (* acc n)))))', 4), 24)
  assert.equal(await invoke('(lambda (x) (let ((a 1)) (begin (set! a 2) a)))', null), 2)
  assert.equal(await invoke('(lambda (x) (cond ((= x 1) "one") ((= x 2) "two") (else "other")))', 2), 'two')
  assert.deepEqual(await invoke('(lambda (x) (quote (1 2)))', null), [1, 2])
  assert.throws(() => compileSchemeRule('(lambda (x) (quote foo))'), (err) => err.code === 'SCHEME_QUOTE')
})

test('数值比较缺失时按 R6RS 报类型错误，而不是退化成 deepEqual', async () => {
  assert.equal(await invoke('(lambda (x) (= x 2))', 2), true)
  await assert.rejects(
    () => invoke('(lambda (x) (= x "2"))', '2'),
    (err) => err.code === 'PRIMITIVE_ERROR',
  )
})

test('谓词组合子：conjoin/disjoin/not/c/equal/c/list-of/c', async () => {
  assert.equal(await compilePredicate('(lambda (x) ((conjoin) x))', null), true)
  assert.equal(await compilePredicate('(lambda (x) ((disjoin) x))', null), false)
  assert.equal(await compilePredicate('(lambda (x) (any/c x))', null), true)
  assert.equal(await compilePredicate('(lambda (x) (none/c x))', null), false)
  assert.equal(await compilePredicate('(lambda (x) ((all-of number? (lambda (v) (> v 0))) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((any-of (lambda (v) (= v 1)) (lambda (v) (= v 2))) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((conjoin number?) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((conjoin number? (lambda (v) (> v 0))) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((conjoin number? (lambda (v) (> v 0))) x))', -1), false)
  assert.equal(await compilePredicate('(lambda (x) ((disjoin (lambda (v) (= v 1)) (lambda (v) (= v 2))) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((conjoin2 number? (lambda (v) (> v 0))) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((disjoin2 (lambda (v) (= v 1)) (lambda (v) (= v 2))) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((not/c (lambda (v) (= v 1))) x))', 2), true)
  assert.equal(await compilePredicate('(lambda (x) ((equal/c 3) x))', 3), true)
  assert.equal(await compilePredicate('(lambda (x) ((list-of/c number?) x))', [1, 2]), true)
  assert.equal(await compilePredicate('(lambda (x) ((list-of/c number?) x))', [1, '2']), false)
  assert.equal(await compilePredicate('(lambda (x) ((list-of/c number?) x))', 'not-a-list'), false)
})

test('变参组合子按从左到右构造且每个谓词表达式只求值一次', async () => {
  const source = `(lambda (x)
    (let ((log ""))
      (let ((predicate (conjoin
        (begin (set! log (string-append log "a")) number?)
        (begin (set! log (string-append log "b")) (lambda (v) (> v 0))))))
        (list (predicate x) log))))`
  assert.deepEqual(await invoke(source, 2), [true, 'ab'])
  assert.deepEqual(await invoke(source, -1), [false, 'ab'])
})

test('组合子严格拒绝非 boolean 谓词结果', async () => {
  await assert.rejects(
    () => invoke('(lambda (x) ((conjoin (lambda (v) 1) number?) x))', 2),
    /严格 boolean/,
  )
  await assert.rejects(
    () => invoke('(lambda (x) ((ffi-predicate "test.truthy") x))', 2, {
      ffi: (() => {
        const registry = new FfiRegistry()
        registry.define('test.truthy', () => 1, { arity: 1 })
        registry.seal()
        return registry
      })(),
    }),
    /严格 boolean/,
  )
})

test('对象组合子：field/c、object/c、fields/c', async () => {
  const field = '(lambda (x) ((field/c "a" number?) x))'
  assert.equal(await compilePredicate(field, { a: 1 }), true)
  assert.equal(await compilePredicate(field, { a: '1' }), false)
  assert.equal(await compilePredicate(field, {}), false)
  const object = '(lambda (x) ((object/c ("a" number?) ("b" string?)) x))'
  assert.equal(await compilePredicate(object, { a: 1, b: 'x', extra: true }), true)
  assert.equal(await compilePredicate(object, { a: 1 }), false)
  const fields = '(lambda (x) ((fields/c ("a" number?)) x))'
  assert.equal(await compilePredicate(fields, { a: 1 }), true)
})

test('decision-with 保留 pin decision 的对象协议', async () => {
  const source = '(lambda (x) ((decision-with (field/c "ok" (lambda (v) v)) (lambda (v) v)) x))'
  assert.deepEqual(await invoke(source, { ok: true }), { ok: true, accepted: true })
  assert.deepEqual(await invoke(source, { ok: false }), { accepted: false, reason: 'rule_pending' })
  assert.deepEqual(await invoke('(lambda (x) ((decision-with (lambda (v) #f) (lambda (v) (error "selector-called"))) x))', {}), { accepted: false, reason: 'rule_pending' })
})

test('FFI 直接调用、ffi-predicate 与短路组合子', async () => {
  let calls = 0
  const ffi = new FfiRegistry()
  ffi.define('test.positive', ([n]) => n > 0, { arity: 1 })
  ffi.define('test.tick', ([n]) => {
    calls += 1
    return n > 0
  }, { arity: 1 })
  ffi.seal()
  assert.equal(await invoke('(lambda (x) (ffi "test.positive" x))', 3, { ffi }), true)
  const conjoined = '(lambda (x) ((conjoin (ffi-predicate "test.tick") (ffi-predicate "test.tick")) x))'
  calls = 0
  assert.equal(await invoke(conjoined, -1, { ffi }), false)
  assert.equal(calls, 1)
  calls = 0
  assert.equal(await invoke(conjoined, 1, { ffi }), true)
  assert.equal(calls, 2)
})

test('compileSchemePredicate 强制一元 boolean', () => {
  assert.equal(compileSchemePredicate('(lambda (x) (number? x))').signature.result, 'boolean')
  assert.throws(
    () => compileSchemePredicate('(lambda (x y) (number? x))'),
    (err) => err.code === 'SCHEME_PREDICATE_ARITY',
  )
  assert.throws(
    () => compileSchemePredicate('(lambda (x) x)', { signature: { result: 'number' } }),
    (err) => err.code === 'SCHEME_SIGNATURE',
  )
})

test('模块 loader 捕获 helper 闭包并注册多个规则', async () => {
  const source = `
    (define (positive? x) (and (number? x) (> x 0)))
    (define (over? x) (positive? x))
    (define (register id role predicate)
      (register-rule! id "1" predicate (object "role" role "description" "loaded from Scheme")))
    (register "org.example.positive" "decision" (lambda (x) (positive? x)))
    (register "org.example.over" "merge" (lambda (x) (over? x)))
  `
  const loaded = await loadSchemeRules(source)
  assert.deepEqual(loaded.registry.ids(), ['org.example.over', 'org.example.positive'])
  assert.equal(loaded.registry.sealed, true)
  assert.equal(await loaded.registry.call('org.example.positive', [2]), true)
  assert.equal(await loaded.registry.call('org.example.over', [-1]), false)
  assert.equal(loaded.pinRules.merge.id, 'org.example.over')
  assert.equal(loaded.pinRules.decision.source[0], 'lambda')
  assert.equal(loaded.pinRules.ffi.length, 0)
  assert.equal(loaded.descriptors[0].description, 'loaded from Scheme')
  assert.equal(loaded.descriptors[0].role, 'decision')
})

test('模块定义可前向引用（函数体在调用时查找后续绑定）', async () => {
  const loaded = await loadSchemeRules(`
    (define (a? x) (b? x))
    (define (b? x) (number? x))
    (register-rule! "org.example.forward" "1" (lambda (x) (a? x)) (object "role" "decision"))
  `)
  assert.equal(await loaded.registry.call('org.example.forward', [1]), true)
  assert.equal(await loaded.registry.call('org.example.forward', ['1']), false)
})

test('注册闭包不能写模块级绑定，避免快照语义被运行期副作用破坏', async () => {
  await assert.rejects(
    () => loadSchemeRules(`
      (define state 0)
      (define (next? x) (begin (set! state (+ state 1)) (= x state)))
      (register-rule! "org.example.next" "1" (lambda (x) (next? x)))
    `),
    (err) => err.code === 'SCHEME_CAPTURE_MUTATION' || err.code === 'SCHEME_CAPTURE',
  )
})

test('命名 let 注册为每条规则做词法快照', async () => {
  const source = `
    (define (rule-id n) (string-append "org.example.dynamic." (number->string n)))
    (let loop ((i 0))
      (if (< i 3)
          (begin
            (register-rule! (rule-id i) "1" (lambda (x) (= x i)))
            (loop (+ i 1)))
          #f))
  `
  const loaded = await loadSchemeRules(source)
  assert.deepEqual(loaded.registry.ids(), [
    'org.example.dynamic.0',
    'org.example.dynamic.1',
    'org.example.dynamic.2',
  ])
  assert.equal(await loaded.registry.call('org.example.dynamic.0', [0]), true)
  assert.equal(await loaded.registry.call('org.example.dynamic.0', [1]), false)
  assert.equal(await loaded.registry.call('org.example.dynamic.2', [2]), true)
})

test('注册失败不产生部分 registry', async () => {
  const registry = new RuleRegistry()
  registry.define('org.example.taken', ['lambda', ['x'], ['datum', true]])
  await assert.rejects(
    () => loadSchemeRules(`
      (register-rule! "org.example.new" "1" (lambda (x) #t))
      (register-rule! "org.example.taken" "1" (lambda (x) #t))
    `, { registry }),
    (err) => err.code === 'DUPLICATE_RULE',
  )
  assert.deepEqual(registry.ids(), ['org.example.taken'])
})

test('重复 pin role 明确失败且外部 registry 不发生部分写入', async () => {
  const registry = new RuleRegistry()
  await assert.rejects(
    () => loadSchemeRules(`
      (register-rule! "org.example.a" "1" (lambda (x) #t) (object "role" "decision"))
      (register-rule! "org.example.b" "1" (lambda (x) #f) (object "role" "decision"))
    `, { registry }),
    (err) => err.code === 'DUPLICATE_RULE_ROLE',
  )
  assert.deepEqual(registry.ids(), [])
  assert.equal(registry.sealed, false)
})

test('pin 桥：原始 FFI manifest 为 id，normalize 后保留声明并可编译', async () => {
  const ffi = new FfiRegistry()
  ffi.define('test.positive', ([n]) => n > 0, { arity: 1 })
  ffi.seal()
  const loaded = await loadSchemeRules(`
    (define (positive? x) (ffi "test.positive" x))
    (register-rule! "org.example.positive" "1" (lambda (x) (positive? x)) (object "role" "decision"))
  `, { ffi, ffiDeclarations: ['test.positive'] })
  assert.deepEqual(loaded.descriptors[0].ffiManifest, ['test.positive'])
  const raw = pinRulesFromDescriptors(loaded.descriptors, { ffi: ['test.positive'] })
  assert.deepEqual(raw.ffi, ['test.positive'])
  const normalized = normalizePinRules(raw, { ffi })
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors))
  assert.deepEqual(normalized.rules.ffi, [{ id: 'test.positive' }])
  assert.deepEqual(normalized.rules.decision.ffiManifest, ['test.positive'])
  assert.deepEqual(loaded.pinRules, normalized.rules)
})

test('pinRulesFromDescriptors 拒绝缺少 module 的对象式 FFI 声明', () => {
  assert.throws(
    () => pinRulesFromDescriptors([], { ffi: [{ id: 'test.x' }] }),
    (err) => err.code === 'SCHEME_FFI_DECL',
  )
})

test('registerRule 是可直接脚本化的函数接口', async () => {
  const compiled = compileSchemeRule('(lambda (x) (number? x))')
  const registry = new RuleRegistry()
  registerRule(registry, {
    id: 'org.example.script',
    version: '1',
    source: compiled.ast,
    signature: { args: ['any'], result: 'boolean' },
  })
  assert.equal(await registry.call('org.example.script', [1]), true)
  assert.equal(await registry.call('org.example.script', ['1']), false)
})

test('未知 role、非法 version/source/options 在注册前被拒绝', async () => {
  await assert.rejects(
    () => evaluateSchemeModule('(register-rule! "x" "1" (lambda (x) #t) (object "role" "unknown"))'),
    (err) => err.code === 'SCHEME_REGISTER_ROLE',
  )
  await assert.rejects(
    () => evaluateSchemeModule('(register-rule! "x" "1" 1)'),
    (err) => err.code === 'SCHEME_REGISTER_SOURCE',
  )
  await assert.rejects(
    () => evaluateSchemeModule('(register-rule! 1 "1" (lambda (x) #t))'),
    (err) => err.code === 'SCHEME_REGISTER_ID',
  )
  await assert.rejects(
    () => evaluateSchemeModule('(register-rule! "x" 1 (lambda (x) #t))'),
    (err) => err.code === 'SCHEME_REGISTER_VERSION',
  )
  await assert.rejects(
    () => evaluateSchemeModule('(register-rule! "x" "1" (lambda (x) #t) (object "role" "decision" "extra" #t))'),
    (err) => err.code === 'SCHEME_REGISTER_OPTIONS',
  )
})

test('closure 条件、validate-with 与严格谓词边界', async () => {
  assert.equal(await invoke('(lambda (x) (if (lambda (y) y) 1 2))', null), 1)
  assert.equal(await invoke('(lambda (x) (cond ((lambda (y) y) 1) (else 2)))', null), 1)
  assert.equal(await invoke('(lambda (x) (if (and (lambda (y) y) #t) 1 2))', null), 1)
  assert.equal(await invoke('(lambda (x) (if (or #f (lambda (y) y)) 1 2))', null), 1)
  assert.equal(await invoke('(lambda (x) (not (lambda (y) y)))', null), false)
  assert.deepEqual(
    await invoke('(lambda (x) ((validate-with number? "必须是数字") x))', 'x'),
    { ok: false, errors: ['必须是数字'] },
  )
  assert.deepEqual(
    await invoke('(lambda (x) ((validate-with number? "必须是数字") x))', 1),
    { ok: true, errors: [] },
  )
  await assert.rejects(() => invoke('(lambda (x) ((conjoin (lambda (v) 1)) x))', 1), /严格 boolean/)
})

test('注册捕获局部 set!、named let、let* 与固定元数 primitive', async () => {
  const loaded = await loadSchemeRules(`
    (register-rule! "local.set" "1"
      (lambda (x) (let ((n 0)) (set! n (+ n 1)) (= n x))))
    (register-rule! "local.loop" "1"
      (lambda (x) (let loop ((n 0)) (if (= n x) #t (loop (+ n 1))))))
    (register-rule! "local.let-star" "1"
      (lambda (x) (let* ((a x) (b (+ a 1))) (= b 2))))
    (register-rule! "primitive.number" "1" number?)
  `)
  assert.equal(await loaded.registry.call('local.set', [1]), true)
  assert.equal(await loaded.registry.call('local.loop', [4]), true)
  assert.equal(await loaded.registry.call('local.let-star', [1]), true)
  assert.equal(await loaded.registry.call('primitive.number', [1]), true)
  assert.equal(await loaded.registry.call('primitive.number', ['1']), false)
})

test('register-rule! 返回 id，可在加载期脚本中继续使用', async () => {
  const loaded = await loadSchemeRules(`
    (define saved (register-rule! "script.base" "1" (lambda (x) #t)))
    (register-rule! (string-append saved ".copy") "1" (lambda (x) #f))
  `)
  assert.deepEqual(loaded.registry.ids(), ['script.base', 'script.base.copy'])
  assert.ok(loaded.sourceMap['script.base'].length > 0)
  assert.equal(typeof loaded.sourceMap['script.base'][0].line, 'number')
  assert.ok(Object.isFrozen(loaded.sourceMap))
})

test('非法 FFI 声明在提交前失败，外部 registry 保持原状', async () => {
  const ffi = new FfiRegistry()
  ffi.define('test.positive', ([n]) => n > 0, { arity: 1 })
  ffi.seal()
  const registry = new RuleRegistry()
  await assert.rejects(
    () => loadSchemeRules(
      '(register-rule! "ffi.rule" "1" (lambda (x) (ffi "test.positive" x)) (object "role" "decision"))',
      { registry, ffi, ffiDeclarations: [{ id: 'test.positive' }] },
    ),
    (err) => err.code === 'SCHEME_FFI_DECL',
  )
  assert.deepEqual(registry.ids(), [])
  assert.equal(registry.sealed, false)
})

test('JS registerRule 接受 scheme 源码并拒绝未知 options 与双重 source', async () => {
  const registry = new RuleRegistry()
  const returned = registerRule(registry, { id: 'js.scheme', version: '1', role: 'decision', scheme: '(lambda (x) (number? x))' })
  assert.equal(returned, registry)
  assert.equal(registerRule(returned, { id: 'js.second', version: '1', source: ['lambda', ['x'], ['datum', true]] }), registry)
  assert.equal(await registry.call('js.scheme', [1]), true)
  assert.equal(await registry.call('js.second', [null]), true)
  assert.throws(
    () => registerRule(new RuleRegistry(), { id: 'bad', version: '1', scheme: '(lambda (x) #t)', unknown: true }),
    (err) => err.code === 'SCHEME_REGISTER_OPTIONS',
  )
  assert.throws(
    () => registerRule(new RuleRegistry(), { id: 'bad', version: '1', source: ['lambda', ['x'], ['datum', true]], scheme: '(lambda (x) #t)' }),
    (err) => err.code === 'SCHEME_REGISTER_SOURCE',
  )
  assert.throws(
    () => registerRule(new RuleRegistry(), { id: 'bad', version: '1', role: 'unknown', scheme: '(lambda (x) #t)' }),
    (err) => err.code === 'SCHEME_REGISTER_ROLE',
  )
})

test('reader limits 贯穿 compile/module，遮蔽与 hash 身份可复现', async () => {
  assert.throws(
    () => compileSchemeRule('(lambda (x) #t)', { reader: { maxTokens: 2 } }),
    (err) => err.code === 'SCHEME_READ',
  )
  assert.throws(
    () => compileSchemeRule('(lambda (x) #t)', { reader: { unknown: 1 } }),
    (err) => err.code === 'SCHEME_READ',
  )
  await assert.rejects(
    () => evaluateSchemeModule('(register-rule! "x" "1" (lambda (x) #t))', { reader: { maxTokens: 3 } }),
    (err) => err.code === 'SCHEME_READ',
  )
  assert.equal(await invoke('(lambda (x) ((lambda (if) (if #f)) (lambda (v) 42)))', null), 42)
  const plain = compileSchemeRule('(lambda (x) (if x 1 2))')
  const commented = compileSchemeRule('; comment\n(lambda (x) (if x 1 2))')
  assert.equal(plain.hash, commented.hash)
  assert.equal(plain.ast[0], 'lambda')
  const libraryA = `${STANDARD_LIBRARY_SOURCE}\n(define (custom-even? x) (= 0 x))`
  const libraryB = `${STANDARD_LIBRARY_SOURCE}\n(define (custom-even? x) (= 1 x))`
  const astA = lowerSchemeRule('(lambda (x) (custom-even? x))', { standardLibrary: false, freeBindings: standardLibraryBindings(libraryA) }).ast
  const astB = lowerSchemeRule('(lambda (x) (custom-even? x))', { standardLibrary: false, freeBindings: standardLibraryBindings(libraryB) }).ast
  assert.notEqual(compileRule(astA).hash, compileRule(astB).hash)
})

test('公共 dsh-data-curation/rules 出口暴露 Scheme API', async () => {
  const api = await import('dsh-data-curation/rules')
  assert.equal(api.compileSchemeRule, compileSchemeRule)
  assert.equal(api.loadSchemeRules, loadSchemeRules)
  assert.equal(api.registerRule, registerRule)
  assert.equal(await api.compileSchemePredicate('(lambda (x) (number? x))').invoke([1]), true)
})

test('旧 JSON AST 的 golden hash 与语言版本不变', () => {
  const compiled = compileRule(['lambda', [], ['datum', 1]])
  assert.equal(compiled.hash, 'sha256:cbb288a4bdaff339ec5d48438fac57364666aa115bbcf4271ca68d16acc0efe3')
  assert.equal(compiled.languageVersion, 1)
})
