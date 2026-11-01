// lib/pin-rules.js — DSL procedures for pin validation and effective-config merge.
//
// The host still owns structural safety (table names, paths, delivery table,
// fields/records). A pin rule may change domain defaults or merge policy, but
// cannot change the delivery target, field/record declarations or schema.
import { RuleError } from './rules/errors.js'
import { compileRule } from './rules/compiler.js'
import { createDefaultPrimitives } from './rules/primitives.js'
import { normalizeSignature } from './rules/signatures.js'
import { emptyFfiRegistry, normalizeFfiRegistry } from './rules/ffi.js'

export const PIN_RULES_VERSION = 1
export const PIN_RULE_ROLES = Object.freeze(['validate', 'merge', 'canonicalize', 'decision'])

const v = (name) => ['var', name]
const d = (value) => ['datum', value]
const p = (id, ...args) => ['apply', ['primitive', id], args]
const lam = (params, body) => ['lambda', params, body]
const objectGet = (object, key, fallback) => (fallback === undefined
  ? p('object-get', object, key)
  : p('object-get', object, key, fallback))

/**
 * Default procedures are deliberately small adapters: merge delegates to the
 * historical native implementation so a pin without custom rules keeps exactly
 * the same effective config; validate returns the host's structural verdict.
 * Custom procedures can replace either role and are sealed into the pin hash.
 */
export function defaultPinRules() {
  return {
    version: PIN_RULES_VERSION,
    merge: {
      id: 'pin.default.merge',
      version: '1',
      source: lam(['input'], p('pin.merge-table',
        objectGet(v('input'), d('defaults')),
        objectGet(v('input'), d('table')))),
      signature: { args: ['object'], result: 'object' },
    },
    validate: {
      id: 'pin.default.validate',
      version: '1',
      source: lam(['input'], ['if', p('empty?', objectGet(v('input'), d('tables'))),
        d({ ok: false, errors: ['tables 不能为空'] }),
        d({ ok: true, errors: [] })]),
      signature: { args: ['object'], result: 'object' },
    },
  }
}

/**
 * Compile a stored decision rule for compare time. No FFI bindings are wired
 * yet, so a rule that declares FFI cannot run in 0.11.
 */
export function compileDecisionRule(rule, { limits } = {}) {
  return compileRule(rule.source, {
    primitives: createDefaultPrimitives(),
    signature: rule.signature,
    limits,
  })
}

export function createPinPrimitives(mergeTable) {
  return createDefaultPrimitives({
    define: (registry) => {
      registry.define('pin.merge-table', (args) => mergeTable(args[0], args[1]), { arity: 2 })
    },
  })
}

function compileProcedure(role, spec, { ffi, mergeTable }) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RuleError('PIN_RULE_SHAPE', `rules.${role} 必须是对象`, { path: `$.rules.${role}` })
  }
  if (typeof spec.id !== 'string' || !spec.id.trim()) {
    throw new RuleError('PIN_RULE_SHAPE', `rules.${role}.id 必须是非空字符串`, { path: `$.rules.${role}.id` })
  }
  if (typeof spec.version !== 'string' || !spec.version.trim()) {
    throw new RuleError('PIN_RULE_SHAPE', `rules.${role}.version 必须是非空字符串`, { path: `$.rules.${role}.version` })
  }
  if (spec.source === undefined) {
    throw new RuleError('PIN_RULE_SHAPE', `rules.${role}.source 必须是 JSON AST`, { path: `$.rules.${role}.source` })
  }
  const signature = spec.signature === undefined ? undefined : normalizeSignature(spec.signature)
  const compiled = compileRule(spec.source, {
    primitives: createPinPrimitives(mergeTable),
    signature,
    ffi,
  })
  const normalized = {
    id: spec.id,
    version: spec.version,
    source: spec.source,
    hash: compiled.hash,
    ffiManifest: compiled.ffiManifest,
  }
  if (signature) normalized.signature = signature
  return { normalized, compiled }
}

/**
 * Normalize and compile the `rules` block of a pin.
 * @returns {{ok:boolean, errors?:string[], rules?:object, compiled?:object}}
 */
export function normalizePinRules(input, { ffi = emptyFfiRegistry(), mergeTable } = {}) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['pin.rules 必须是对象'] }
  }
  for (const key of Object.keys(input)) {
    if (!['version', 'ffi', ...PIN_RULE_ROLES].includes(key)) errors.push(`pin.rules 有未知键：${key}`)
  }
  if (input.version !== PIN_RULES_VERSION) {
    errors.push(`pin.rules.version 必须是 ${PIN_RULES_VERSION}`)
  }
  if (input.ffi !== undefined && (!Array.isArray(input.ffi) || input.ffi.some((id) => typeof id !== 'string' || !id.trim()))) {
    errors.push('pin.rules.ffi 必须是字符串数组')
  }
  if (errors.length) return { ok: false, errors }

  let ffiRegistry
  try {
    ffiRegistry = normalizeFfiRegistry(ffi)
  } catch (error) {
    return { ok: false, errors: [`pin.rules.ffi 声明无效：${error.message}`] }
  }

  const rules = { version: PIN_RULES_VERSION, ffi: [...(input.ffi ?? [])].sort() }
  const compiled = {}
  for (const role of PIN_RULE_ROLES) {
    const spec = input[role]
    if (spec === undefined) continue
    try {
      const built = compileProcedure(role, spec, { ffi: ffiRegistry, mergeTable })
      if (role === 'canonicalize') {
        errors.push('pin.rules.canonicalize 在 0.11 暂不支持；规范化仍由宿主执行')
        continue
      }
      rules[role] = built.normalized
      compiled[role] = built.compiled
    } catch (error) {
      const code = error instanceof RuleError ? error.code : 'PIN_RULE_ERROR'
      errors.push(`rules.${role}（${spec?.id ?? '?'}）编译失败 [${code}]：${error.message}`)
    }
  }
  if (errors.length) return { ok: false, errors }
  rules.ffi = [...new Set([
    ...rules.ffi,
    ...Object.values(rules).flatMap((role) => (role?.ffiManifest ?? [])),
  ])].sort()
  return { ok: true, rules, compiled }
}

export function invokePinRule(compiled, role, input) {
  const rule = compiled?.[role]
  if (!rule) return null
  return rule.invoke([input])
}

export function pinRuleRefs(rules) {
  if (!rules) return []
  return PIN_RULE_ROLES
    .filter((role) => rules[role])
    .map((role) => ({ role, id: rules[role].id, version: rules[role].version, hash: rules[role].hash }))
}
