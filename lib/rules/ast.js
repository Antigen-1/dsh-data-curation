// lib/rules/ast.js — JSON value validation, cloning and core form names.
import { RuleError } from './errors.js'

export const CORE_FORMS = Object.freeze([
  'datum',
  'var',
  'primitive',
  'if',
  'set!',
  'lambda',
  'apply',
  'begin',
  'ffi',
])

const CORE = new Set(CORE_FORMS)
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isRuleNode(value) {
  return Array.isArray(value)
}

export function isCoreForm(op) {
  return CORE.has(op)
}

/**
 * Clone a JSON value while rejecting non-JSON data and prototype-pollution keys.
 * The path in errors points to the offending child, not only the containing node.
 */
export function cloneJsonValue(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RuleError('MALFORMED_AST', '数值必须是有限 JSON number', { path })
    return value
  }
  if (typeof value !== 'object') {
    throw new RuleError('MALFORMED_AST', `不是 JSON 值：${typeof value}`, { path })
  }
  if (seen.has(value)) throw new RuleError('MALFORMED_AST', 'JSON 值不能包含循环引用', { path })
  seen.add(value)

  let out
  if (Array.isArray(value)) {
    out = value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`, seen))
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new RuleError('MALFORMED_AST', '只接受纯 JSON object', { path })
    }
    out = {}
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new RuleError('MALFORMED_AST', `对象键名不允许使用 ${key}`, { path: pathFor(path, key) })
      }
      out[key] = cloneJsonValue(item, pathFor(path, key), seen)
    }
  }
  seen.delete(value)
  return out
}

export function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)
  if (!Object.isFrozen(value)) Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item, seen)
  return value
}

export function pathFor(path, ...parts) {
  return parts.reduce((p, part) => (typeof part === 'number' ? `${p}[${part}]` : `${p}.${part}`), path)
}
