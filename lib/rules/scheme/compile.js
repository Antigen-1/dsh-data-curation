// lib/rules/scheme/compile.js — compile Scheme source through the existing v1
// checker/interpreter, preserving the JSON AST as the persisted authority.
import { RuleError } from '../errors.js'
import { compileRule } from '../compiler.js'
import { normalizeSignature } from '../signatures.js'
import { lowerSchemeRule } from './lower.js'

function predicateSignature(signature) {
  const normalized = normalizeSignature(signature)
  if (normalized?.result && normalized.result !== 'boolean') {
    throw new RuleError('SCHEME_SIGNATURE', '谓词签名的 result 必须是 boolean', { path: '$.signature.result' })
  }
  return { ...(normalized ?? {}), result: 'boolean' }
}

function assertLambdaAst(ast) {
  if (!Array.isArray(ast) || ast[0] !== 'lambda') {
    throw new RuleError('RULE_MUST_BE_PROCEDURE', 'Scheme 规则必须 lower 为 lambda', { path: '$' })
  }
  return ast
}

/**
 * Compile Scheme rule source to the normal compiled-rule object. The persisted
 * identity is still `compiled.ast`; the Scheme text is diagnostic metadata only.
 */
export function compileSchemeRule(source, options = {}) {
  const lowered = lowerSchemeRule(source, options)
  const ast = assertLambdaAst(lowered.ast)
  const compiled = compileRule(ast, options)
  return Object.freeze({
    ...compiled,
    sourceMap: lowered.sourceMap,
    schemeSource: source,
  })
}

/** Compile a one-argument Scheme predicate and enforce a boolean result. */
export function compileSchemePredicate(source, options = {}) {
  const lowered = lowerSchemeRule(source, options)
  const ast = assertLambdaAst(lowered.ast)
  if (!Array.isArray(ast[1]) || ast[1].length !== 1) {
    throw new RuleError('SCHEME_PREDICATE_ARITY', '谓词必须恰好接收一个参数', { path: '$[1]' })
  }
  const signature = predicateSignature(options.signature)
  const compiled = compileRule(ast, { ...options, signature })
  return Object.freeze({
    ...compiled,
    sourceMap: lowered.sourceMap,
    schemeSource: source,
  })
}
