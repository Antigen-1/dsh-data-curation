// lib/rules/ffi.js — explicit, host-declared foreign bindings only.
import { cloneJsonValue } from './ast.js'
import { RuleError } from './errors.js'
import { arityMatches, describeArity, normalizeArity } from './primitives.js'

/**
 * FFI bindings are trusted host functions. The DSL cannot discover bindings
 * or obtain Node globals; a rule is only allowed to call ids listed in the
 * compiled rule's manifest.
 */
export class FfiRegistry {
  #bindings = new Map()
  #sealed = false

  define(id, fn, { arity } = {}) {
    if (this.#sealed) throw new Error('FFI registry 已封存，不能再注册')
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('FFI binding id 必须是非空字符串')
    if (typeof fn !== 'function') throw new TypeError(`FFI binding ${id} 必须提供函数`)
    if (this.#bindings.has(id)) throw new Error(`FFI binding 重复注册：${id}`)
    this.#bindings.set(id, Object.freeze({ fn, arity: normalizeArity(arity) }))
    return this
  }

  seal() {
    this.#sealed = true
    return this
  }

  get sealed() {
    return this.#sealed
  }

  has(id) {
    return this.#bindings.has(id)
  }

  ids() {
    return [...this.#bindings.keys()].sort()
  }

  arityOf(id) {
    return this.#bindings.get(id)?.arity
  }

  async call(id, args, path = '$') {
    const binding = this.#bindings.get(id)
    if (!binding) throw new RuleError('UNKNOWN_FFI', `未知 FFI binding：${id}`, { path })
    if (!Array.isArray(args)) throw new RuleError('MALFORMED_AST', 'FFI 参数必须是数组', { path })
    if (!arityMatches(binding.arity, args.length)) {
      throw new RuleError(
        'ARITY_MISMATCH',
        `FFI binding ${id} 需要 ${describeArity(binding.arity)} 个参数，实际 ${args.length} 个`,
        { path },
      )
    }
    let result
    try {
      result = await binding.fn(args.map((arg) => cloneJsonValue(arg, path)), { path })
    } catch (error) {
      if (error instanceof RuleError) throw error
      throw new RuleError('FFI_ERROR', `FFI binding ${id} 执行失败：${error?.message ?? String(error)}`, { path })
    }
    try {
      return cloneJsonValue(result, path)
    } catch (error) {
      if (error instanceof RuleError) {
        throw new RuleError('FFI_RESULT', `FFI binding ${id} 返回了非 JSON 值`, { path, detail: error.message })
      }
      throw error
    }
  }
}

export function emptyFfiRegistry() {
  return new FfiRegistry().seal()
}

export function normalizeFfiRegistry(input) {
  if (input === undefined || input === null) return emptyFfiRegistry()
  if (input instanceof FfiRegistry) {
    if (!input.sealed) throw new TypeError('FFI registry 必须已封存')
    return input
  }
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ffi 必须是 FfiRegistry 或 {id: fn} 对象')
  const registry = new FfiRegistry()
  for (const [id, binding] of Object.entries(input)) {
    if (typeof binding === 'function') registry.define(id, binding)
    else if (binding && typeof binding.fn === 'function') registry.define(id, binding.fn, { arity: binding.arity })
    else throw new TypeError(`FFI binding ${id} 必须是函数或 {fn, arity}`)
  }
  return registry.seal()
}
