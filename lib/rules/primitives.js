// lib/rules/primitives.js — host-registered pure primitives for the rules DSL.
import { cloneJsonValue } from './ast.js'
import { RuleError } from './errors.js'

const INFINITY = Number.POSITIVE_INFINITY

export function normalizeArity(arity) {
  if (arity === undefined) return Object.freeze({ min: 0, max: INFINITY })
  if (Number.isSafeInteger(arity) && arity >= 0) return Object.freeze({ min: arity, max: arity })
  if (
    arity &&
    typeof arity === 'object' &&
    Number.isSafeInteger(arity.min) &&
    (Number.isSafeInteger(arity.max) || arity.max === INFINITY) &&
    arity.min >= 0 &&
    arity.min <= arity.max
  ) {
    return Object.freeze({ min: arity.min, max: arity.max })
  }
  throw new TypeError(`原语参数个数声明无效：${JSON.stringify(arity)}`)
}

export function arityMatches(arity, count) {
  return count >= arity.min && count <= arity.max
}

export function describeArity(arity) {
  if (arity.min === arity.max) return `${arity.min}`
  if (arity.max === INFINITY) return `至少 ${arity.min}`
  return `${arity.min}..${arity.max}`
}

export function isTruthy(value) {
  return value !== false && value !== null
}

/**
 * Immutable primitive lookup. A registry can be extended until `seal()`.
 * `call` enforces arity and JSON-only arguments/results.
 */
export class PrimitiveRegistry {
  #specs = new Map()
  #sealed = false

  define(id, fn, { arity } = {}) {
    if (this.#sealed) throw new Error('primitive registry 已封存，不能再注册')
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('primitive id 必须是非空字符串')
    if (typeof fn !== 'function') throw new TypeError(`primitive ${id} 必须提供函数`)
    if (this.#specs.has(id)) throw new Error(`primitive 重复注册：${id}`)
    this.#specs.set(id, Object.freeze({ fn, arity: normalizeArity(arity) }))
    return this
  }

  seal() {
    this.#sealed = true
    return this
  }

  has(id) {
    return this.#specs.has(id)
  }

  get size() {
    return this.#specs.size
  }

  get sealed() {
    return this.#sealed
  }

  ids() {
    return [...this.#specs.keys()].sort()
  }

  arityOf(id) {
    return this.#specs.get(id)?.arity
  }

  async call(id, args, path = '$') {
    const spec = this.#specs.get(id)
    if (!spec) throw new RuleError('UNKNOWN_PRIMITIVE', `未知 primitive：${id}`, { path })
    if (!Array.isArray(args)) throw new RuleError('MALFORMED_AST', 'primitive 参数必须是数组', { path })
    if (!arityMatches(spec.arity, args.length)) {
      throw new RuleError(
        'ARITY_MISMATCH',
        `primitive ${id} 需要 ${describeArity(spec.arity)} 个参数，实际 ${args.length} 个`,
        { path },
      )
    }
    let result
    try {
      result = await spec.fn(args, { path })
    } catch (error) {
      if (error instanceof RuleError) throw error
      throw new RuleError('PRIMITIVE_ERROR', `primitive ${id} 执行失败：${error?.message ?? String(error)}`, { path })
    }
    try {
      return cloneJsonValue(result, path)
    } catch (error) {
      if (error instanceof RuleError) {
        throw new RuleError('PRIMITIVE_RESULT', `primitive ${id} 返回了非 JSON 值`, { path, detail: error.message })
      }
      throw error
    }
  }
}

function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} 必须是有限数字`)
  return value
}

function string(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} 必须是字符串`)
  return value
}

function array(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} 必须是数组`)
  return value
}

function numericPair(args) {
  return [number(args[0], '第 1 个参数'), number(args[1], '第 2 个参数')]
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

export function createDefaultPrimitives() {
  const registry = new PrimitiveRegistry()

  registry.define('+', (args) => args.reduce((sum, v, i) => sum + number(v, `第 ${i + 1} 个参数`), 0))
  registry.define('-', (args) => {
    const values = args.map((v, i) => number(v, `第 ${i + 1} 个参数`))
    if (values.length === 1) return -values[0]
    return values.slice(1).reduce((acc, v) => acc - v, values[0])
  }, { arity: { min: 1, max: INFINITY } })
  registry.define('*', (args) => args.reduce((product, v, i) => product * number(v, `第 ${i + 1} 个参数`), 1))
  registry.define('/', (args) => {
    const values = args.map((v, i) => number(v, `第 ${i + 1} 个参数`))
    if (values.length === 1) {
      if (values[0] === 0) throw new TypeError('除数不能为 0')
      return 1 / values[0]
    }
    return values.slice(1).reduce((acc, v) => {
      if (v === 0) throw new TypeError('除数不能为 0')
      return acc / v
    }, values[0])
  }, { arity: { min: 1, max: INFINITY } })
  registry.define('modulo', (args) => {
    const left = number(args[0], '第 1 个参数')
    const right = number(args[1], '第 2 个参数')
    if (right === 0) throw new TypeError('除数不能为 0')
    return left % right
  }, { arity: 2 })
  registry.define('abs', (args) => Math.abs(number(args[0], '第 1 个参数')), { arity: 1 })
  registry.define('min', (args) => Math.min(...args.map((v, i) => number(v, `第 ${i + 1} 个参数`))), { arity: { min: 1, max: INFINITY } })
  registry.define('max', (args) => Math.max(...args.map((v, i) => number(v, `第 ${i + 1} 个参数`))), { arity: { min: 1, max: INFINITY } })

  registry.define('=', (args) => args.slice(1).every((v) => deepEqual(args[0], v)), { arity: { min: 2, max: INFINITY } })
  registry.define('<', (args) => { const [a, b] = numericPair(args); return a < b }, { arity: 2 })
  registry.define('<=', (args) => { const [a, b] = numericPair(args); return a <= b }, { arity: 2 })
  registry.define('>', (args) => { const [a, b] = numericPair(args); return a > b }, { arity: 2 })
  registry.define('>=', (args) => { const [a, b] = numericPair(args); return a >= b }, { arity: 2 })

  registry.define('not', (args) => !isTruthy(args[0]), { arity: 1 })
  registry.define('boolean?', (args) => typeof args[0] === 'boolean', { arity: 1 })
  registry.define('number?', (args) => typeof args[0] === 'number' && Number.isFinite(args[0]), { arity: 1 })
  registry.define('string?', (args) => typeof args[0] === 'string', { arity: 1 })
  registry.define('list?', (args) => Array.isArray(args[0]), { arity: 1 })
  registry.define('null?', (args) => args[0] === null, { arity: 1 })
  registry.define('empty?', (args) => (Array.isArray(args[0]) || typeof args[0] === 'string') && args[0].length === 0, { arity: 1 })
  registry.define('pair?', (args) => Array.isArray(args[0]) && args[0].length > 0, { arity: 1 })

  registry.define('list', (args) => args)
  registry.define('cons', (args) => [args[0], ...array(args[1], '第 2 个参数')], { arity: 2 })
  registry.define('car', (args) => {
    const list = array(args[0], '第 1 个参数')
    if (list.length === 0) throw new TypeError('car 不能作用于空列表')
    return list[0]
  }, { arity: 1 })
  registry.define('cdr', (args) => {
    const list = array(args[0], '第 1 个参数')
    if (list.length === 0) throw new TypeError('cdr 不能作用于空列表')
    return list.slice(1)
  }, { arity: 1 })
  registry.define('length', (args) => {
    const value = args[0]
    if (typeof value !== 'string' && !Array.isArray(value)) throw new TypeError('length 只接受字符串或数组')
    return value.length
  }, { arity: 1 })
  registry.define('append', (args) => [...array(args[0], '第 1 个参数'), ...array(args[1], '第 2 个参数')], { arity: 2 })

  registry.define('string-append', (args) => args.map((v, i) => string(v, `第 ${i + 1} 个参数`)).join(''))
  registry.define('number->string', (args) => String(number(args[0], '第 1 个参数')), { arity: 1 })
  registry.define('string->number', (args) => {
    const text = string(args[0], '第 1 个参数').trim()
    if (!text) return null
    const value = Number(text)
    return Number.isFinite(value) ? value : null
  }, { arity: 1 })
  registry.define('string-repeat', (args) => {
    const text = string(args[0], '第 1 个参数')
    const count = number(args[1], '第 2 个参数')
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('重复次数必须是非负整数')
    if (count > 1_000_000) throw new TypeError('重复次数超过 1000000 上限')
    return text.repeat(count)
  }, { arity: 2 })

  registry.define('equal?', (args) => deepEqual(args[0], args[1]), { arity: 2 })
  registry.define('json->string', (args) => JSON.stringify(args[0]), { arity: 1 })
  registry.define('error', (args) => {
    throw new TypeError(string(args[0], '错误消息'))
  }, { arity: 1 })

  return registry.seal()
}
