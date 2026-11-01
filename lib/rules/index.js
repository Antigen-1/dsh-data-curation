// lib/rules/index.js — public surface for the JSON rules DSL (0.9.0).
import { CORE_FORMS, cloneJsonValue, deepFreeze } from './ast.js'
import { CapabilitySet, EffectJournal, createRuleContext } from './capabilities.js'
import { checkRule } from './check.js'
import { RULE_LANGUAGE_VERSION, compileRule, runRule } from './compiler.js'
import { RuleError } from './errors.js'
import { expandRule } from './expand.js'
import { FfiRegistry, emptyFfiRegistry, normalizeFfiRegistry } from './ffi.js'
import { evaluateRule } from './interpreter.js'
import { DEFAULT_LIMITS, normalizeLimits } from './limits.js'
import { PrimitiveRegistry, createDefaultPrimitives } from './primitives.js'
import { RuleRegistry } from './registry.js'
import {
  SIGNATURE_TYPES,
  canonicalJson,
  checkSignatureArgs,
  checkSignatureResult,
  normalizeSignature,
  ruleHash,
  typeMatches,
} from './signatures.js'

export {
  CORE_FORMS,
  CapabilitySet,
  DEFAULT_LIMITS,
  EffectJournal,
  FfiRegistry,
  PrimitiveRegistry,
  RuleError,
  RuleRegistry,
  SIGNATURE_TYPES,
  canonicalJson,
  checkRule,
  checkSignatureArgs,
  checkSignatureResult,
  cloneJsonValue,
  compileRule,
  createDefaultPrimitives,
  createRuleContext,
  deepFreeze,
  emptyFfiRegistry,
  evaluateRule,
  expandRule,
  normalizeFfiRegistry,
  normalizeLimits,
  normalizeSignature,
  ruleHash,
  RULE_LANGUAGE_VERSION,
  runRule,
  typeMatches,
}

export { runRuleIsolated } from './isolated.js'
