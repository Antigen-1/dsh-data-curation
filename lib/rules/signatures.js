// lib/rules/signatures.js — rule identity, input/output signatures and content hashes.
import { createHash } from 'node:crypto'
import { cloneJsonValue, isRuleNode } from './ast.js'
import { RuleError } from './errors.js'

export const SIGNATURE_TYPES = Object.freeze([
  'any', 'json', 'number', 'string', 'boolean', 'null', 'array', 'object',
])

function canonical(value) {
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw new TypeError(`无法 canonicalize 值：${typeof value}`)
}

export function canonicalJson(value) {
  return canonical(value)
}

function assertType(type, path) {
  if (!SIGNATURE_TYPES.includes(type)) {
    throw new RuleError('INVALID_SIGNATURE', `未知签名类型：${String(type)}`, { path, detail: { allowed: SIGNATURE_TYPES } })
  }
  return type
}

/**
 * A signature is `{args?: type[], result?: type}`. Every declared position and
 * the result are checked at the public invoke boundary.
 */
export function normalizeSignature(signature) {
  if (signature === undefined || signature === null) return null
  if (typeof signature !== 'object' || Array.isArray(signature)) {
    throw new RuleError('INVALID_SIGNATURE', 'signature 必须是对象', { path: '$.signature' })
  }
  const unknown = Object.keys(signature).filter((key) => key !== 'args' && key !== 'result')
  if (unknown.length) {
    throw new RuleError('INVALID_SIGNATURE', `signature 含未知键：${unknown.join(', ')}`, { path: '$.signature' })
  }
  const out = {}
  if (signature.args !== undefined) {
    if (!Array.isArray(signature.args)) throw new RuleError('INVALID_SIGNATURE', 'signature.args 必须是类型数组', { path: '$.signature.args' })
    out.args = signature.args.map((type, index) => assertType(type, `$.signature.args[${index}]`))
  }
  if (signature.result !== undefined) out.result = assertType(signature.result, '$.signature.result')
  return Object.freeze(out)
}

export function typeMatches(value, type) {
  switch (type) {
    case 'any':
    case 'json':
      return true
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return false
  }
}

export function checkSignatureArgs(signature, args, path = '$args') {
  if (!signature?.args) return
  if (args.length !== signature.args.length) {
    throw new RuleError('SIGNATURE_MISMATCH', `规则需要 ${signature.args.length} 个参数，实际 ${args.length} 个`, { path })
  }
  signature.args.forEach((type, index) => {
    if (!typeMatches(args[index], type)) {
      throw new RuleError('SIGNATURE_MISMATCH', `第 ${index + 1} 个参数不是 ${type}`, { path: `${path}[${index}]`, detail: { expected: type } })
    }
  })
}

export function checkSignatureResult(signature, value, path = '$result') {
  if (!signature?.result) return
  if (!typeMatches(value, signature.result)) {
    throw new RuleError('SIGNATURE_MISMATCH', `规则返回值不是 ${signature.result}`, { path, detail: { expected: signature.result } })
  }
}

/**
 * Content-addressed identity for a rule: source AST, declared signature and
 * the FFI binding ids it is allowed to call. Order is canonical.
 */
export function ruleHash(source, { signature = null, ffi = [] } = {}) {
  if (!isRuleNode(source)) throw new RuleError('MALFORMED_AST', '规则源码必须是 JSON 数组', { path: '$' })
  const payload = {
    source: cloneJsonValue(source, '$'),
    signature: signature ?? null,
    ffi: [...new Set(ffi)].sort(),
  }
  return `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`
}
