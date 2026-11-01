// lib/rules/index.js — experimental public surface for the rules DSL (0.8.0).
import { CORE_FORMS, cloneJsonValue, deepFreeze } from './ast.js'
import { checkRule } from './check.js'
import { RuleError } from './errors.js'
import { evaluateRule } from './interpreter.js'
import { DEFAULT_LIMITS, normalizeLimits } from './limits.js'
import { PrimitiveRegistry, createDefaultPrimitives } from './primitives.js'

export { CORE_FORMS, DEFAULT_LIMITS, PrimitiveRegistry, RuleError, checkRule, cloneJsonValue, createDefaultPrimitives, deepFreeze, evaluateRule, normalizeLimits }

/**
 * Compile and freeze a rule. `invoke(args)` accepts positional JSON arguments.
 * A per-call limits override is merged over the compiled defaults.
 */
export function compileRule(source, options = {}) {
  const primitives = options.primitives ?? createDefaultPrimitives()
  if (primitives?.sealed !== true) throw new TypeError('primitives 必须是已封存的 PrimitiveRegistry')
  const limits = normalizeLimits(options.limits)
  const checked = checkRule(source, { primitives, limits })
  const compiled = {
    ast: checked.ast,
    limits,
    nodeCount: checked.nodeCount,
    maxDepth: checked.maxDepth,
    async invoke(args = [], runtime = {}) {
      const callLimits = runtime.limits ? normalizeLimits({ ...limits, ...runtime.limits }) : limits
      return evaluateRule(checked.ast, args, { primitives, limits: callLimits, now: runtime.now })
    },
  }
  return Object.freeze(compiled)
}

export async function runRule(source, args = [], options = {}) {
  return compileRule(source, options).invoke(args)
}
