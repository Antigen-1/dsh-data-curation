// lib/rules/scheme/lower.js — R6RS-subset frontend lowered to the v1 JSON AST.
//
// The lowering target stays small on purpose: datums, variables, primitives,
// if, set!, lambda, apply, begin and ffi. Scheme truth, numeric adapters and
// predicate combinators are expanded here so the core runtime does not change.
import { RuleError } from '../errors.js'
import { pathFor } from '../ast.js'
import { readScheme, symbolName } from './reader.js'
import { STANDARD_LIBRARY_SOURCE } from './stdlib.js'

const PRIMITIVE_GLOBALS = new Map([
  ['+', '+'],
  ['-', '-'],
  ['*', '*'],
  ['/', '/'],
  ['modulo', 'modulo'],
  ['abs', 'abs'],
  ['min', 'min'],
  ['max', 'max'],
  ['<', '<'],
  ['<=', '<='],
  ['>', '>'],
  ['>=', '>='],
  ['boolean?', 'boolean?'],
  ['number?', 'number?'],
  ['string?', 'string?'],
  ['list?', 'list?'],
  ['pair?', 'pair?'],
  ['empty?', 'empty?'],
  ['null?', 'null?'],
  ['list', 'list'],
  ['cons', 'cons'],
  ['car', 'car'],
  ['cdr', 'cdr'],
  ['length', 'length'],
  ['append', 'append'],
  ['string-append', 'string-append'],
  ['number->string', 'number->string'],
  ['string->number', 'string->number'],
  ['string=?', 'string=?'],
  ['equal?', 'equal?'],
  ['json->string', 'json->string'],
  ['error', 'error'],
  ['object?', 'object?'],
  ['object-keys', 'object-keys'],
  ['object-has?', 'object-has?'],
  ['object-get', 'object-get'],
  ['object-set', 'object-set'],
  ['object-remove', 'object-remove'],
  ['object-merge', 'object-merge'],
  ['capability?', 'capability?'],
  ['data.get', 'data.get'],
  ['effects.stage', 'effects.stage'],
])

const MACROS = new Set([
  'conjoin', 'disjoin', 'all-of', 'any-of', 'not/c', 'equal/c', 'list-of/c',
  'field/c', 'object/c', 'fields/c', 'decision-with', 'ffi-predicate',
])

function datum(kind, value, span) {
  return { kind, value, span }
}

function isSymbol(datumValue, name) {
  return datumValue?.kind === 'symbol' && (name === undefined || datumValue.value === name)
}

function isList(datumValue) {
  return datumValue?.kind === 'list'
}

function formName(datumValue) {
  return isList(datumValue) ? symbolName(datumValue.items[0]) : null
}

function listPath(base, index) {
  return pathFor(base, index)
}

class Scope {
  constructor(parent = null) {
    this.parent = parent
    this.bindings = new Map()
  }

  hasLocal(name) {
    return this.bindings.has(name)
  }

  define(name, internal) {
    this.bindings.set(name, internal)
  }

  lookup(name) {
    for (let scope = this; scope; scope = scope.parent) {
      if (scope.bindings.has(name)) return scope.bindings.get(name)
    }
    return null
  }
}

function schemeError(code, message, span, path = '$') {
  const where = span ? `（第 ${span.line} 行第 ${span.column} 列）` : ''
  return new RuleError(code, `${message}${where}`, {
    path,
    detail: span ? { line: span.line, column: span.column, start: span.start, end: span.end } : undefined,
  })
}

export class Lowerer {
  #counter = 0
  #freeBindings
  #sourceMap = []
  #allowRegister

  constructor({ freeBindings = null, allowRegister = false, standardLibrary = true } = {}) {
    const bindings = new Map()
    if (standardLibrary) {
      for (const [name, ast] of standardLibraryBindings()) bindings.set(name, ast)
    }
    if (freeBindings) {
      for (const [name, ast] of freeBindings) bindings.set(name, ast)
    }
    this.#freeBindings = bindings
    this.#allowRegister = allowRegister
  }

  gensym(prefix = 's') {
    this.#counter += 1
    return `${prefix}__${this.#counter}`
  }

  record(path, span) {
    if (span) this.#sourceMap.push({ path, start: span.start, end: span.end, line: span.line, column: span.column })
  }

  get sourceMap() {
    return this.#sourceMap
  }

  fail(code, message, span, path = '$') {
    throw schemeError(code, message, span, path)
  }

  expectSymbol(value, label, path = '$') {
    if (!isSymbol(value)) this.fail('SCHEME_SYNTAX', `${label} 必须是标识符`, value?.span, path)
    return value.value
  }

  expectList(value, label, path = '$') {
    if (!isList(value)) this.fail('SCHEME_SYNTAX', `${label} 必须是 proper list`, value?.span, path)
    return value.items
  }

  expectProperArity(items, min, max, label, span, path) {
    if (items.length < min || (max !== null && items.length > max)) {
      const wanted = max === min ? `${min}` : max === null ? `至少 ${min}` : `${min}..${max}`
      this.fail('SCHEME_ARITY', `${label} 需要 ${wanted} 个参数，实际 ${items.length} 个`, span, path)
    }
  }

  /**
   * Lower one expression datum. `scope` is lexical; free names are resolved
   * through the module closure's captured binding table when present.
   */
  lower(datumValue, scope, path = '$') {
    if (!datumValue || typeof datumValue !== 'object') this.fail('SCHEME_SYNTAX', '缺少表达式', null, path)
    this.record(path, datumValue.span)
    switch (datumValue.kind) {
      case 'number':
        return ['datum', datumValue.value]
      case 'string':
        return ['datum', datumValue.value]
      case 'boolean':
        return ['datum', datumValue.value]
      case 'symbol':
        return this.lowerSymbol(datumValue, scope, path)
      case 'list':
        return this.lowerList(datumValue, scope, path)
      default:
        this.fail('SCHEME_SYNTAX', `不支持的 datum 类型：${datumValue.kind}`, datumValue.span, path)
    }
  }

  lowerSymbol(datumValue, scope, path) {
    const name = datumValue.value
    if (name === '%json-null') return ['datum', null]
    const local = scope.lookup(name)
    if (local) return ['var', local]
    const free = this.#freeBindings?.get(name)
    if (free) return free
    const primitive = PRIMITIVE_GLOBALS.get(name)
    if (primitive) return ['primitive', primitive]
    const global = this.lowerGlobal(name, scope, path, datumValue.span)
    if (global) return global
    this.fail(
      'UNBOUND_VARIABLE',
      `未绑定变量：${name}。可用全局名请参考 docs/RULES.md；模块 helper 需先 define`,
      datumValue.span,
      path,
    )
  }

  lowerGlobal(name, scope, path, span) {
    switch (name) {
      case 'not':
        return ['lambda', ['x'], this.lowerNot(['var', 'x'])]
      case '=':
        return this.numericEqual()
      case 'null?':
        return this.schemeNullPredicate()
      case 'json-null?':
        return ['lambda', ['x'], ['apply', ['primitive', 'null?'], [['var', 'x']]]]
      case 'string->number':
        return this.stringToNumber()
      case 'conjoin2':
        return this.conjoin2Procedure(false)
      case 'disjoin2':
        return this.conjoin2Procedure(true)
      case 'any/c':
        return ['lambda', ['x'], ['datum', true]]
      case 'none/c':
        return ['lambda', ['x'], ['datum', false]]
      default:
        return null
    }
  }

  numericEqual() {
    const a = 'a'
    const b = 'b'
    const lt = (left, right) => ['apply', ['primitive', '<'], [['var', left], ['var', right]]]
    return ['lambda', [a, b], ['if', lt(a, b), ['datum', false], ['if', lt(b, a), ['datum', false], ['datum', true]]]]
  }

  schemeNullPredicate() {
    const x = 'x'
    return ['lambda', [x], ['if',
      ['apply', ['primitive', 'list?'], [['var', x]]],
      ['if', ['apply', ['primitive', 'empty?'], [['var', x]]], ['datum', true], ['datum', false]],
      ['datum', false],
    ]]
  }

  stringToNumber() {
    const x = 'x'
    const n = this.gensym('n')
    return ['lambda', [x], ['apply', ['lambda', [n], ['if',
      ['apply', ['primitive', 'null?'], [['var', n]]],
      ['datum', false],
      ['var', n],
    ]], [['apply', ['primitive', 'string->number'], [['var', x]]]]]]
  }

  lowerList(datumValue, scope, path) {
    const items = datumValue.items
    if (items.length === 0) {
      this.fail('SCHEME_SYNTAX', '空列表只能出现在 quote 中', datumValue.span, path)
    }
    const name = symbolName(items[0])
    if (name) {
      const local = scope.lookup(name)
      if (!local && this.#freeBindings?.has(name)) {
        // A captured procedure shadows global syntax; treat it as an application.
      } else if (!local) {
        switch (name) {
          case 'quote':
            this.expectProperArity(items, 2, 2, 'quote', datumValue.span, path)
            return ['datum', this.quoteValue(items[1], pathFor(path, 1))]
          case 'if':
            this.expectProperArity(items, 4, 4, 'if', datumValue.span, path)
            return this.lowerIf(
              this.lower(items[1], scope, listPath(path, 1)),
              this.lower(items[2], scope, listPath(path, 2)),
              this.lower(items[3], scope, listPath(path, 3)),
            )
          case 'cond':
            return this.lowerCond(items, scope, path, datumValue.span)
          case 'and':
            return this.lowerAnd(items.slice(1).map((item, index) => this.lower(item, scope, listPath(path, index + 1))))
          case 'or':
            return this.lowerOr(items.slice(1).map((item, index) => this.lower(item, scope, listPath(path, index + 1))))
          case 'not':
            this.expectProperArity(items, 2, 2, 'not', datumValue.span, path)
            return this.lowerNot(this.lower(items[1], scope, listPath(path, 1)))
          case 'begin':
            if (items.length < 2) this.fail('SCHEME_SYNTAX', 'begin 至少需要一个表达式', datumValue.span, path)
            return this.sequence(items.slice(1).map((item, index) => this.lower(item, scope, listPath(path, index + 1))))
          case 'lambda':
            return this.lowerLambda(items, scope, path, datumValue.span)
          case 'set!':
            return this.lowerSet(items, scope, path, datumValue.span)
          case 'let':
            return this.lowerLet(items, scope, path, datumValue.span, 'let')
          case 'let*':
            return this.lowerLet(items, scope, path, datumValue.span, 'let*')
          case 'letrec':
          case 'letrec*':
            return this.lowerLet(items, scope, path, datumValue.span, 'letrec')
          case 'define':
            this.fail('SCHEME_DEFINE_CONTEXT', 'define 只能出现在模块顶层', datumValue.span, path)
            break
          case 'register-rule!':
            if (!this.#allowRegister) {
              this.fail('SCHEME_REGISTER_CONTEXT', 'register-rule! 只能在模块加载期调用，不能出现在 rule 内部', datumValue.span, path)
            }
            return this.lowerRegister(items, scope, path, datumValue.span)
          case 'ffi':
            return this.lowerFfi(items, scope, path, datumValue.span)
          case 'object':
            return this.lowerObject(items, scope, path, datumValue.span)
          default:
            if (MACROS.has(name)) return this.lowerMacro(name, items, scope, path, datumValue.span)
        }
      }
    }
    const operator = this.lower(items[0], scope, listPath(path, 0))
    const args = items.slice(1).map((item, index) => this.lower(item, scope, listPath(path, index + 1)))
    return ['apply', operator, args]
  }

  lowerRegister(items, scope, path, span) {
    this.expectProperArity(items, 4, 5, 'register-rule!', span, path)
    const id = this.lower(items[1], scope, listPath(path, 1))
    const version = this.lower(items[2], scope, listPath(path, 2))
    const source = this.lower(items[3], scope, listPath(path, 3))
    const options = items.length === 5
      ? this.lower(items[4], scope, listPath(path, 4))
      : ['datum', {}]
    return ['module-register', id, version, source, options]
  }

  lowerObject(items, scope, path, span) {
    if ((items.length - 1) % 2 !== 0) {
      this.fail('SCHEME_ARITY', 'object 需要偶数个 key/value 参数', span, path)
    }
    let result = ['datum', {}]
    for (let index = 1; index < items.length; index += 2) {
      const key = this.lower(items[index], scope, listPath(path, index))
      const value = this.lower(items[index + 1], scope, listPath(path, index + 1))
      result = ['apply', ['primitive', 'object-set'], [result, key, value]]
    }
    return result
  }

  lowerFfi(items, scope, path, span) {
    this.expectProperArity(items, 2, null, 'ffi', span, path)
    const id = items[1]
    if (id.kind !== 'string' || !id.value.trim()) {
      this.fail('SCHEME_FFI', 'ffi 的第一个参数必须是非空字符串 binding id', id.span, pathFor(path, 1))
    }
    const args = items.slice(2).map((item, index) => this.lower(item, scope, listPath(path, index + 2)))
    return ['ffi', id.value, ...args]
  }

  quoteValue(value, path) {
    switch (value.kind) {
      case 'number':
      case 'string':
      case 'boolean':
        return value.value
      case 'symbol':
        this.fail('SCHEME_QUOTE', 'quote 不支持 symbol；本前端把标识符保留给变量绑定，不把它映射为字符串', value.span, path)
        break
      case 'list': {
        const out = value.items.map((item, index) => this.quoteValue(item, pathFor(path, index)))
        return out
      }
      default:
        this.fail('SCHEME_QUOTE', `quote 不支持 ${value.kind}`, value.span, path)
    }
  }

  lowerIf(test, consequent, alternate) {
    const tmp = this.gensym('t')
    return ['apply', ['lambda', [tmp], ['if', this.truthyOf(['var', tmp]), consequent, alternate]], [test]]
  }

  /** AST that returns #t iff `value` is truthy under R6RS rules. */
  truthyOf(value) {
    return ['if', value,
      ['datum', true],
      ['if', ['apply', ['primitive', 'null?'], [value]], ['datum', true], ['datum', false]],
    ]
  }

  /** AST that returns #t iff `value` is exactly #f (closure-safe). */
  falseOf(value) {
    return ['if', value,
      ['datum', false],
      ['if', ['apply', ['primitive', 'null?'], [value]], ['datum', false], ['datum', true]],
    ]
  }

  bindMany(expressions, body, names = null) {
    if (expressions.length === 0) return body
    const params = names ?? expressions.map(() => this.gensym('v'))
    return ['apply', ['lambda', params, body], expressions]
  }

  lowerNot(ast) {
    return this.lowerNotAst(ast)
  }

  lowerNotAst(ast) {
    const tmp = this.gensym('n')
    return ['apply', ['lambda', [tmp], ['if', this.falseOf(['var', tmp]), ['datum', true], ['datum', false]]], [ast]]
  }

  lowerAnd(asts) {
    if (asts.length === 0) return ['datum', true]
    const build = (index) => {
      if (index === asts.length - 1) return asts[index]
      const tmp = this.gensym('and')
      return ['apply', ['lambda', [tmp], ['if', this.falseOf(['var', tmp]), ['var', tmp], build(index + 1)]], [asts[index]]]
    }
    return build(0)
  }

  lowerOr(asts) {
    if (asts.length === 0) return ['datum', false]
    const build = (index) => {
      if (index === asts.length - 1) return asts[index]
      const tmp = this.gensym('or')
      return ['apply', ['lambda', [tmp], ['if', this.falseOf(['var', tmp]), build(index + 1), ['var', tmp]]], [asts[index]]]
    }
    return build(0)
  }

  lowerCond(items, scope, path, span) {
    if (items.length < 2) this.fail('SCHEME_SYNTAX', 'cond 至少需要一个分支', span, path)
    const clauses = []
    for (let index = 1; index < items.length; index++) {
      const raw = items[index]
      const clausePath = listPath(path, index)
      if (!isList(raw) || raw.items.length < 2) {
        this.fail('SCHEME_SYNTAX', 'cond 分支必须是 [test, expression...]', raw?.span, clausePath)
      }
      const isElse = isSymbol(raw.items[0], 'else')
      if (isElse && index !== items.length - 1) this.fail('SCHEME_SYNTAX', 'cond 的 else 必须是最后一个分支', raw.items[0].span, clausePath)
      if (isSymbol(raw.items[0], '=>')) this.fail('SCHEME_UNSUPPORTED', 'cond 的 => 形式暂不支持', raw.items[0].span, clausePath)
      if (raw.items[1] && isSymbol(raw.items[1], '=>')) this.fail('SCHEME_UNSUPPORTED', 'cond 的 => 形式暂不支持', raw.items[1].span, clausePath)
      const test = isElse ? null : this.lower(raw.items[0], scope, listPath(clausePath, 0))
      const body = this.sequence(raw.items.slice(1).map((item, bodyIndex) => this.lower(item, scope, listPath(clausePath, bodyIndex + 1))))
      clauses.push({ test, body })
    }
    if (!clauses.some((clause) => clause.test === null)) {
      this.fail('SCHEME_SYNTAX', 'cond 必须显式包含 else 分支', span, path)
    }
    let cursor = ['datum', false]
    for (let index = clauses.length - 1; index >= 0; index--) {
      const clause = clauses[index]
      if (!clause.test) {
        cursor = clause.body
        continue
      }
      const tmp = this.gensym('cond')
      cursor = ['apply', ['lambda', [tmp], ['if', this.truthyOf(['var', tmp]), clause.body, cursor]], [clause.test]]
    }
    return cursor
  }

  lowerLambda(items, scope, path, span) {
    this.expectProperArity(items, 3, null, 'lambda', span, path)
    const params = this.expectList(items[1], 'lambda 参数表', listPath(path, 1))
    const inner = new Scope(scope)
    const renamed = params.map((param, index) => {
      const name = this.expectSymbol(param, 'lambda 参数', listPath(listPath(path, 1), index))
      if (inner.hasLocal(name)) this.fail('DUPLICATE_PARAMETER', `lambda 参数重复：${name}`, param.span, listPath(listPath(path, 1), index))
      const internal = this.gensym(name)
      inner.define(name, internal)
      return internal
    })
    const body = this.sequence(items.slice(2).map((item, index) => this.lower(item, inner, listPath(path, index + 2))))
    return ['lambda', renamed, body]
  }

  lowerSet(items, scope, path, span) {
    this.expectProperArity(items, 3, 3, 'set!', span, path)
    const name = this.expectSymbol(items[1], 'set! 目标', listPath(path, 1))
    const local = scope.lookup(name)
    if (!local) {
      this.fail('SCHEME_CAPTURE_MUTATION', `set! 只能修改词法局部变量：${name}`, items[1].span, listPath(path, 1))
    }
    return ['set!', local, this.lower(items[2], scope, listPath(path, 2))]
  }

  parseBindings(raw, path, scope) {
    const bindings = this.expectList(raw, '绑定表', path)
    const seen = new Set()
    return bindings.map((binding, index) => {
      const bindingPath = listPath(path, index)
      if (!isList(binding) || binding.items.length !== 2) {
        this.fail('SCHEME_SYNTAX', '绑定必须是 (name expression)', binding?.span, bindingPath)
      }
      const name = this.expectSymbol(binding.items[0], '绑定名', listPath(bindingPath, 0))
      if (seen.has(name)) this.fail('DUPLICATE_PARAMETER', `绑定重复：${name}`, binding.items[0].span, bindingPath)
      seen.add(name)
      return { name, init: binding.items[1], bindingPath }
    })
  }

  lowerLet(items, scope, path, span, kind) {
    if (kind === 'let' && isSymbol(items[1])) {
      this.expectProperArity(items, 4, null, 'named let', span, path)
      const name = items[1].value
      const bindings = this.parseBindings(items[2], listPath(path, 2), scope)
      const inits = bindings.map((binding, index) => this.lower(binding.init, scope, listPath(binding.bindingPath, 1)))
      const inner = new Scope(scope)
      const internalName = this.gensym(name)
      inner.define(name, internalName)
      const params = bindings.map((binding, index) => {
        const internal = this.gensym(binding.name)
        inner.define(binding.name, internal)
        return [internal, inits[index]]
      })
      const body = this.sequence(items.slice(3).map((item, index) => this.lower(item, inner, listPath(path, index + 3))))
      return ['let', internalName, params, body]
    }

    this.expectProperArity(items, 3, null, kind, span, path)
    const bindings = this.parseBindings(items[1], listPath(path, 1), scope)
    const body = items.slice(2)

    if (kind === 'let') {
      const inner = new Scope(scope)
      const params = bindings.map((binding, index) => {
        const internal = this.gensym(binding.name)
        inner.define(binding.name, internal)
        return [internal, this.lower(binding.init, scope, listPath(binding.bindingPath, 1))]
      })
      return ['let', params, this.sequence(body.map((item, index) => this.lower(item, inner, listPath(path, index + 2))))]
    }

    if (kind === 'let*') {
      let inner = scope
      const asts = []
      for (const binding of bindings) {
        const internal = this.gensym(binding.name)
        const init = this.lower(binding.init, inner, listPath(binding.bindingPath, 1))
        const next = new Scope(inner)
        next.define(binding.name, internal)
        asts.push({ internal, init })
        inner = next
      }
      let cursor = this.sequence(body.map((item, index) => this.lower(item, inner, listPath(path, index + 2))))
      for (let index = asts.length - 1; index >= 0; index--) {
        cursor = ['let', [[asts[index].internal, asts[index].init]], cursor]
      }
      return cursor
    }

    const inner = new Scope(scope)
    const names = bindings.map((binding) => {
      const internal = this.gensym(binding.name)
      inner.define(binding.name, internal)
      return internal
    })
    const params = bindings.map((binding, index) => [names[index], this.lower(binding.init, inner, listPath(binding.bindingPath, 1))])
    return ['letrec', params, this.sequence(body.map((item, index) => this.lower(item, inner, listPath(path, index + 2))))]
  }

  sequence(asts) {
    if (asts.length === 0) this.fail('SCHEME_SYNTAX', '函数体不能为空', null)
    return asts.length === 1 ? asts[0] : ['begin', ...asts]
  }

  makePredicateApplication(predicateVar, argAst) {
    return ['apply', ['var', predicateVar], [argAst]]
  }

  /** Reject any non-boolean predicate result while evaluating `ast` once. */
  strictBoolean(ast) {
    const result = this.gensym('predicate_result')
    return ['apply', ['lambda', [result], ['if',
      ['apply', ['primitive', 'boolean?'], [['var', result]]],
      ['var', result],
      ['apply', ['primitive', 'error'], [['datum', '合同谓词必须返回严格 boolean']]],
    ]], [ast]]
  }

  /** Call a flat contract and reject any non-boolean result. */
  strictPredicateApplication(predicateVar, argAst) {
    return this.strictBoolean(this.makePredicateApplication(predicateVar, argAst))
  }

  conjoin2Procedure(disjoin = false) {
    const left = this.gensym('p')
    const right = this.gensym('q')
    const arg = this.gensym('x')
    const calls = [
      this.strictPredicateApplication(left, ['var', arg]),
      this.strictPredicateApplication(right, ['var', arg]),
    ]
    const body = disjoin ? this.lowerOr(calls) : this.lowerAnd(calls)
    return ['lambda', [left, right], ['lambda', [arg], body]]
  }

  lowerMacro(name, items, scope, path, span) {
    if (name === 'conjoin' || name === 'disjoin' || name === 'all-of' || name === 'any-of') {
      const predicates = items.slice(1).map((item, index) => this.lower(item, scope, listPath(path, index + 1)))
      const arg = this.gensym('x')
      const predNames = predicates.map(() => this.gensym('p'))
      const calls = predNames.map((predicate) => this.strictPredicateApplication(predicate, ['var', arg]))
      const body = name === 'conjoin' || name === 'all-of' ? this.lowerAnd(calls) : this.lowerOr(calls)
      return this.bindMany(predicates, ['lambda', [arg], body], predNames)
    }

    if (name === 'not/c') {
      this.expectProperArity(items, 2, 2, 'not/c', span, path)
      const predicate = this.lower(items[1], scope, listPath(path, 1))
      const predName = this.gensym('p')
      const arg = this.gensym('x')
      const call = this.strictPredicateApplication(predName, ['var', arg])
      return this.bindMany([predicate], ['lambda', [arg], this.lowerNotAst(call)], [predName])
    }

    if (name === 'equal/c') {
      this.expectProperArity(items, 2, 2, 'equal/c', span, path)
      const expected = this.lower(items[1], scope, listPath(path, 1))
      const expectedName = this.gensym('expected')
      const arg = this.gensym('x')
      const equal = ['apply', ['primitive', 'equal?'], [['var', arg], ['var', expectedName]]]
      return this.bindMany([expected], ['lambda', [arg], equal], [expectedName])
    }

    if (name === 'list-of/c') {
      this.expectProperArity(items, 2, 2, 'list-of/c', span, path)
      const predicate = this.lower(items[1], scope, listPath(path, 1))
      const predName = this.gensym('p')
      const arg = this.gensym('x')
      const rest = this.gensym('rest')
      const loop = this.gensym('loop')
      const loopBody = ['if',
        ['apply', ['primitive', 'empty?'], [['var', rest]]],
        ['datum', true],
        this.lowerIf(
          this.strictPredicateApplication(predName, ['apply', ['primitive', 'car'], [['var', rest]]]),
          ['apply', ['var', loop], [['apply', ['primitive', 'cdr'], [['var', rest]]]]],
          ['datum', false],
        ),
      ]
      const body = ['if',
        ['apply', ['primitive', 'list?'], [['var', arg]]],
        ['let', loop, [[rest, ['var', arg]]], loopBody],
        ['datum', false],
      ]
      return this.bindMany([predicate], ['lambda', [arg], body], [predName])
    }

    if (name === 'field/c') {
      this.expectProperArity(items, 3, 3, 'field/c', span, path)
      const key = this.lower(items[1], scope, listPath(path, 1))
      const predicate = this.lower(items[2], scope, listPath(path, 2))
      const keyName = this.gensym('key')
      const predName = this.gensym('p')
      const arg = this.gensym('x')
      const body = ['if',
        ['apply', ['primitive', 'object?'], [['var', arg]]],
        ['if',
          ['apply', ['primitive', 'object-has?'], [['var', arg], ['var', keyName]]],
          this.strictPredicateApplication(predName, ['apply', ['primitive', 'object-get'], [['var', arg], ['var', keyName]]]),
          ['datum', false],
        ],
        ['datum', false],
      ]
      return this.bindMany([key, predicate], ['lambda', [arg], body], [keyName, predName])
    }

    if (name === 'object/c' || name === 'fields/c') {
      const clauses = items.slice(1)
      if (clauses.length === 0) this.fail('SCHEME_SYNTAX', 'object/c 至少需要一个字段', span, path)
      const keys = []
      const predicates = []
      for (let index = 0; index < clauses.length; index++) {
        const clause = clauses[index]
        const clausePath = listPath(path, index + 1)
        const parts = this.expectList(clause, 'object/c 字段', clausePath)
        if (parts.length !== 2) this.fail('SCHEME_SYNTAX', 'object/c 字段必须是 ("name" predicate)', clause.span, clausePath)
        if (parts[0].kind !== 'string' || !parts[0].value) {
          this.fail('SCHEME_SYNTAX', 'object/c 字段名必须是字符串字面量', parts[0].span, listPath(clausePath, 0))
        }
        keys.push(parts[0].value)
        predicates.push(this.lower(parts[1], scope, listPath(clausePath, 1)))
      }
      const arg = this.gensym('x')
      const keyNames = keys.map(() => this.gensym('key'))
      const predNames = predicates.map(() => this.gensym('p'))
      let checks = ['datum', true]
      for (let index = keys.length - 1; index >= 0; index--) {
        const has = ['apply', ['primitive', 'object-has?'], [['var', arg], ['var', keyNames[index]]]]
        const value = ['apply', ['primitive', 'object-get'], [['var', arg], ['var', keyNames[index]]]]
        const pred = this.strictPredicateApplication(predNames[index], value)
        checks = ['if', has, ['if', pred, checks, ['datum', false]], ['datum', false]]
      }
      const body = ['if', ['apply', ['primitive', 'object?'], [['var', arg]]], checks, ['datum', false]]
      return this.bindMany(
        [...keys.map((key) => ['datum', key]), ...predicates],
        ['lambda', [arg], body],
        [...keyNames, ...predNames],
      )
    }

    if (name === 'decision-with') {
      this.expectProperArity(items, 3, 3, 'decision-with', span, path)
      const accept = this.lower(items[1], scope, listPath(path, 1))
      const selector = this.lower(items[2], scope, listPath(path, 2))
      const acceptName = this.gensym('accept')
      const selectName = this.gensym('select')
      const input = this.gensym('input')
      const base = this.gensym('base')
      const selected = ['apply', ['var', selectName], [['var', input]]]
      const accepted = ['apply', ['primitive', 'object-set'], [['var', base], ['datum', 'accepted'], ['datum', true]]]
      const pending = ['apply', ['primitive', 'object-set'], [
        ['apply', ['primitive', 'object-set'], [['var', base], ['datum', 'accepted'], ['datum', false]]],
        ['datum', 'reason'], ['datum', 'rule_pending'],
      ]]
      const body = ['apply', ['lambda', [base], ['if',
        this.strictPredicateApplication(acceptName, ['var', input]),
        accepted,
        pending,
      ]], [selected]]
      return this.bindMany([accept, selector], ['lambda', [input], body], [acceptName, selectName])
    }

    if (name === 'ffi-predicate') {
      this.expectProperArity(items, 2, 2, 'ffi-predicate', span, path)
      const id = items[1]
      if (id.kind !== 'string' || !id.value.trim()) {
        this.fail('SCHEME_FFI', 'ffi-predicate 的参数必须是非空字符串 binding id', id.span, listPath(path, 1))
      }
      const arg = this.gensym('x')
      return ['lambda', [arg], this.strictBoolean(['ffi', id.value, ['var', arg]])]
    }

    this.fail('SCHEME_UNSUPPORTED', `未实现的组合子：${name}`, span, path)
  }

}

let cachedStandardLibrary = null

function parseStandardLibraryDefinition(form) {
  if (formName(form) !== 'define') {
    throw schemeError('SCHEME_STDLIB', '标准库只能包含顶层 define', form?.span, '$stdlib')
  }
  const items = form.items
  if (items.length < 3) throw schemeError('SCHEME_STDLIB', '标准库 define 缺少表达式', form.span, '$stdlib')
  const target = items[1]
  if (isSymbol(target)) {
    if (items.length !== 3) throw schemeError('SCHEME_STDLIB', '标准库变量 define 只能有一个表达式', form.span, '$stdlib')
    return { name: target.value, expression: items[2] }
  }
  if (!isList(target) || target.items.length === 0 || !isSymbol(target.items[0])) {
    throw schemeError('SCHEME_STDLIB', '标准库函数 define 目标无效', form.span, '$stdlib')
  }
  if (target.items.slice(1).some((param) => !isSymbol(param))) {
    throw schemeError('SCHEME_STDLIB', '标准库函数参数必须是标识符', form.span, '$stdlib')
  }
  return {
    name: target.items[0].value,
    expression: {
      kind: 'list',
      items: [datum('symbol', 'lambda', target.span), {
        kind: 'list', items: target.items.slice(1), span: target.span,
      }, ...items.slice(2)],
      span: form.span,
    },
  }
}

/**
 * Lower the authoritative Scheme library once. Each definition captures only
 * earlier library definitions, so referencing one name inlines exactly its
 * reachable dependency closure into the v1 AST before hashing.
 */
export function standardLibraryBindings(source = STANDARD_LIBRARY_SOURCE) {
  const useCache = source === STANDARD_LIBRARY_SOURCE
  if (useCache && cachedStandardLibrary) return new Map(cachedStandardLibrary)
  const bindings = new Map()
  const { datums } = readScheme(source)
  for (const form of datums) {
    if (form.kind === 'directive') continue
    const definition = parseStandardLibraryDefinition(form)
    if (bindings.has(definition.name)) {
      throw schemeError('SCHEME_STDLIB', `标准库定义重复：${definition.name}`, form.span, '$stdlib')
    }
    const lowerer = new Lowerer({ freeBindings: bindings, standardLibrary: false })
    bindings.set(definition.name, lowerer.lower(definition.expression, new Scope(null), '$stdlib'))
  }
  if (useCache) cachedStandardLibrary = bindings
  return new Map(bindings)
}

/** Root scope for the module loader and lowerSchemeExpression. */
export function createSchemeScope() {
  return new Scope(null)
}

/** Lower one datum with the same options used by the module loader. */
export function lowerSchemeDatum(datumValue, options = {}) {
  const lowerer = new Lowerer(options)
  const ast = lowerer.lower(datumValue, new Scope(null), '$')
  return { ast, sourceMap: lowerer.sourceMap, lowerer }
}

/** Lower an already-read lambda-shaped closure with captured free variables. */
export function lowerSchemeClosure({ params, body, span, freeBindings = null }) {
  const lowerer = new Lowerer({ freeBindings })
  const scope = new Scope(null)
  const internal = params.map((name) => {
    const generated = lowerer.gensym(name)
    scope.define(name, generated)
    return generated
  })
  const bodyAst = lowerer.sequence(body.map((item, index) => lowerer.lower(item, scope, `$body[${index}]`)))
  return {
    ast: ['lambda', internal, bodyAst],
    sourceMap: lowerer.sourceMap,
    span,
  }
}

function readerOptionsOf(options) {
  if (options.reader !== undefined) return options.reader
  const picked = {}
  for (const key of ['maxSourceBytes', 'maxTokens', 'maxDepth']) {
    if (Object.hasOwn(options, key)) picked[key] = options[key]
  }
  return picked
}

/** Lower a single Scheme expression (used by tests and the module loader). */
export function lowerSchemeExpression(source, options = {}) {
  const { datums } = readScheme(source, readerOptionsOf(options))
  if (datums.length !== 1) throw schemeError('SCHEME_TOP_LEVEL', '需要且只需要一个表达式', datums[0]?.span)
  const lowerer = new Lowerer({ standardLibrary: options.standardLibrary !== false })
  return {
    ast: lowerer.lower(datums[0], new Scope(null), '$'),
    sourceMap: lowerer.sourceMap,
    source,
  }
}

/**
 * Lower a complete rule source. The result is still unchecked v1 AST; callers
 * must run compileRule (or compileSchemeRule) to get identity and invocation.
 */
export function lowerSchemeRule(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Scheme 源码必须是字符串')
  const parsed = readScheme(source, readerOptionsOf(options))
  const datums = parsed.datums.filter((item) => item.kind !== 'directive')
  if (datums.length !== 1) {
    throw schemeError('SCHEME_TOP_LEVEL', '规则源码必须恰好包含一个顶层 lambda 表达式', datums[1]?.span ?? datums[0]?.span)
  }
  if (formName(datums[0]) !== 'lambda') {
    throw schemeError('RULE_MUST_BE_PROCEDURE', 'Scheme 规则必须写成 (lambda (input) body ...)', datums[0]?.span)
  }
  const lowerer = new Lowerer({
    freeBindings: options.freeBindings ?? null,
    standardLibrary: options.standardLibrary !== false,
  })
  const ast = lowerer.lower(datums[0], new Scope(null), '$')
  return {
    ast,
    sourceMap: lowerer.sourceMap,
    source,
    parsed,
  }
}
