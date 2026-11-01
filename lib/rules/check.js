// lib/rules/check.js — structural and lexical validation before execution.
import { cloneJsonValue, deepFreeze, isCoreForm, isRuleNode, pathFor } from './ast.js'
import { RuleError } from './errors.js'
import { normalizeLimits } from './limits.js'
import { arityMatches, createDefaultPrimitives, describeArity } from './primitives.js'

function bindingExists(scopes, name) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(name)) return true
  }
  return false
}

function checkStaticArity(operator, operandCount, path, primitives) {
  if (!Array.isArray(operator)) return
  if (operator[0] === 'primitive' && typeof operator[1] === 'string' && primitives.has(operator[1])) {
    const arity = primitives.arityOf(operator[1])
    if (!arityMatches(arity, operandCount)) {
      throw new RuleError(
        'ARITY_MISMATCH',
        `primitive ${operator[1]} 需要 ${describeArity(arity)} 个参数，实际 ${operandCount} 个`,
        { path },
      )
    }
  }
  if (operator[0] === 'lambda' && Array.isArray(operator[1]) && operandCount !== operator[1].length) {
    throw new RuleError(
      'ARITY_MISMATCH',
      `lambda 需要 ${operator[1].length} 个参数，实际 ${operandCount} 个`,
      { path },
    )
  }
}

/**
 * Validate a rule source, return a frozen JSON clone and its static size.
 * A rule source is a top-level lambda expression.
 */
export function checkRule(source, options = {}) {
  const limits = normalizeLimits(options.limits)
  const primitives = options.primitives ?? createDefaultPrimitives()
  if (primitives?.sealed !== true) throw new TypeError('primitives 必须是已封存的 PrimitiveRegistry')
  const ast = cloneJsonValue(source, '$')
  if (!isRuleNode(ast) || ast[0] !== 'lambda') {
    throw new RuleError('RULE_MUST_BE_PROCEDURE', '规则源码必须是一个 lambda procedure', { path: '$' })
  }

  const stats = { nodes: 0, maxDepth: 0 }
  const scopes = [new Map()]

  function walk(node, path, depth) {
    stats.nodes += 1
    stats.maxDepth = Math.max(stats.maxDepth, depth)
    if (stats.nodes > limits.maxAstNodes) {
      throw new RuleError('AST_LIMIT', `AST 节点数超过上限 ${limits.maxAstNodes}`, { path })
    }
    if (depth > limits.maxAstDepth) {
      throw new RuleError('AST_LIMIT', `AST 深度超过上限 ${limits.maxAstDepth}`, { path })
    }
    if (!isRuleNode(node)) {
      throw new RuleError('MALFORMED_AST', '节点必须是 JSON 数组', { path })
    }
    const op = node[0]
    if (typeof op !== 'string') {
      throw new RuleError('MALFORMED_AST', '节点第一个元素必须是操作名字符串', { path })
    }

    switch (op) {
      case 'datum': {
        if (node.length !== 2) throw new RuleError('MALFORMED_AST', 'datum 需要且只接受一个值', { path })
        cloneJsonValue(node[1], pathFor(path, 1))
        return
      }
      case 'var': {
        if (node.length !== 2 || typeof node[1] !== 'string' || !node[1]) {
          throw new RuleError('MALFORMED_AST', 'var 需要一个非空变量名', { path })
        }
        if (!bindingExists(scopes, node[1])) {
          throw new RuleError('UNBOUND_VARIABLE', `未绑定变量：${node[1]}`, { path })
        }
        return
      }
      case 'primitive': {
        if (node.length !== 2 || typeof node[1] !== 'string' || !node[1]) {
          throw new RuleError('MALFORMED_AST', 'primitive 需要一个非空原语名', { path })
        }
        if (!primitives.has(node[1])) {
          throw new RuleError('UNKNOWN_PRIMITIVE', `未知 primitive：${node[1]}`, { path })
        }
        return
      }
      case 'ffi':
        throw new RuleError('FFI_UNAVAILABLE', '0.8.0 尚未提供 FFI binding', { path })
      case 'if': {
        if (node.length !== 4) throw new RuleError('MALFORMED_AST', 'if 需要条件、分支和否则分支', { path })
        walk(node[1], pathFor(path, 1), depth + 1)
        walk(node[2], pathFor(path, 2), depth + 1)
        walk(node[3], pathFor(path, 3), depth + 1)
        return
      }
      case 'set!': {
        if (node.length !== 3 || typeof node[1] !== 'string' || !node[1]) {
          throw new RuleError('MALFORMED_AST', 'set! 需要变量名和值', { path })
        }
        if (!bindingExists(scopes, node[1])) {
          throw new RuleError('UNBOUND_VARIABLE', `set! 目标未绑定：${node[1]}`, { path: pathFor(path, 1) })
        }
        walk(node[2], pathFor(path, 2), depth + 1)
        return
      }
      case 'lambda': {
        if (node.length !== 3 || !Array.isArray(node[1])) {
          throw new RuleError('MALFORMED_AST', 'lambda 需要参数数组和函数体', { path })
        }
        const scope = new Map()
        node[1].forEach((param, index) => {
          if (typeof param !== 'string' || !param) {
            throw new RuleError('MALFORMED_AST', 'lambda 参数必须是非空字符串', { path: pathFor(pathFor(path, 1), index) })
          }
          if (scope.has(param)) {
            throw new RuleError('DUPLICATE_PARAMETER', `lambda 参数重复：${param}`, { path: pathFor(pathFor(path, 1), index) })
          }
          scope.set(param, true)
        })
        scopes.push(scope)
        try {
          walk(node[2], pathFor(path, 2), depth + 1)
        } finally {
          scopes.pop()
        }
        return
      }
      case 'apply': {
        if (node.length !== 3 || !Array.isArray(node[2])) {
          throw new RuleError('MALFORMED_AST', 'apply 需要 operator 和参数数组', { path })
        }
        walk(node[1], pathFor(path, 1), depth + 1)
        node[2].forEach((operand, index) => walk(operand, pathFor(pathFor(path, 2), index), depth + 1))
        checkStaticArity(node[1], node[2].length, path, primitives)
        return
      }
      case 'begin': {
        if (node.length < 2) throw new RuleError('MALFORMED_AST', 'begin 至少需要一个表达式', { path })
        for (let i = 1; i < node.length; i++) walk(node[i], pathFor(path, i), depth + 1)
        return
      }
      default:
        if (!isCoreForm(op)) throw new RuleError('UNKNOWN_FORM', `未知形式：${op}`, { path })
        throw new RuleError('MALFORMED_AST', `形式 ${op} 未实现`, { path })
    }
  }

  walk(ast, '$', 0)
  return {
    ast: deepFreeze(ast),
    nodeCount: stats.nodes,
    maxDepth: stats.maxDepth,
    limits,
    primitives,
  }
}
