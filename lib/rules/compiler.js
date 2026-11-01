// lib/rules/compiler.js — compile a checked rule with identity and capabilities.
import { checkRule } from './check.js'
import { EffectJournal, createRuleContext } from './capabilities.js'
import { RuleError } from './errors.js'
import { normalizeFfiRegistry } from './ffi.js'
import { evaluateRule } from './interpreter.js'
import { normalizeLimits } from './limits.js'
import { createDefaultPrimitives } from './primitives.js'
import { checkSignatureArgs, checkSignatureResult, normalizeSignature, ruleHash } from './signatures.js'

export const RULE_LANGUAGE_VERSION = 1

/**
 * Compile and freeze a rule. `invoke(args)` accepts positional JSON arguments.
 * A per-call limits/capability/FFI override is merged at the call boundary.
 */
export function compileRule(source, options = {}) {
  const primitives = options.primitives ?? createDefaultPrimitives()
  if (primitives?.sealed !== true) throw new TypeError('primitives 必须是已封存的 PrimitiveRegistry')
  const limits = normalizeLimits(options.limits)
  const ffi = normalizeFfiRegistry(options.ffi)
  const signature = normalizeSignature(options.signature)
  const checked = checkRule(source, { primitives, limits, ffiBindings: ffi })
  const hash = ruleHash(source, { signature, ffi: ffi.ids() })

  async function run(args = [], runtime = {}) {
    if (runtime.ffi !== undefined) {
      throw new RuleError('FFI_UNAVAILABLE', '编译后不能替换 FFI registry', { path: '$' })
    }
    checkSignatureArgs(signature, args)
    const callLimits = runtime.limits ? normalizeLimits({ ...limits, ...runtime.limits }) : limits
    const effects = runtime.effects ?? new EffectJournal()
    const context = runtime.context ?? createRuleContext({ capabilities: runtime.capabilities ?? options.capabilities, effects })
    const result = await evaluateRule(checked.ast, args, {
      primitives,
      limits: callLimits,
      now: runtime.now,
      ffi,
      context,
    })
    checkSignatureResult(signature, result)
    return { result, effects }
  }

  const compiled = {
    languageVersion: RULE_LANGUAGE_VERSION,
    ast: checked.ast,
    limits,
    signature,
    hash,
    ffiManifest: ffi.ids(),
    nodeCount: checked.nodeCount,
    maxDepth: checked.maxDepth,
    async invoke(args = [], runtime = {}) {
      return (await run(args, runtime)).result
    },
    async invokeWithEffects(args = [], runtime = {}) {
      const { result, effects } = await run(args, runtime)
      return Object.freeze({ result, effects: effects.entries() })
    },
  }
  return Object.freeze(compiled)
}

export async function runRule(source, args = [], options = {}) {
  return compileRule(source, options).invoke(args)
}
