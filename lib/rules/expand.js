// lib/rules/expand.js — desugar advanced forms into the small core AST.
import { pathFor } from './ast.js'
import { RuleError } from './errors.js'

function malformed(message, path) {
  return new RuleError('MALFORMED_AST', message, { path })
}

function isBinding(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[0]
}

function bindings(value, path) {
  if (!Array.isArray(value)) throw malformed('let 绑定必须是数组', path)
  const seen = new Set()
  return value.map((binding, index) => {
    if (!isBinding(binding)) throw malformed('let 绑定必须是 [name, expression]', pathFor(path, index))
    if (seen.has(binding[0])) throw new RuleError('DUPLICATE_PARAMETER', `let 绑定重复：${binding[0]}`, { path: pathFor(path, index) })
    seen.add(binding[0])
    return binding
  })
}

function bodyOf(node, from, path) {
  if (node.length <= from) throw malformed('let 至少需要一个函数体表达式', path)
  const body = node.slice(from)
  return body.length === 1 ? body[0] : ['begin', ...body]
}

function expandLet(node, path, expand) {
  if (node.length < 3) throw malformed('let 需要绑定和函数体', path)
  if (typeof node[1] === 'string') {
    if (node.length < 4) throw malformed('named let 需要名称、绑定和函数体', path)
    const name = node[1]
    if (!name) throw malformed('named let 名称不能为空', pathFor(path, 1))
    const pairs = bindings(node[2], pathFor(path, 2))
    const params = pairs.map(([key]) => key)
    const inits = pairs.map(([, expr], index) => expand(expr, pathFor(pathFor(path, 2), index)))
    const body = expand(bodyOf(node, 3, pathFor(path, 3)), pathFor(path, 3))
    return ['apply', ['lambda', [name], ['begin',
      ['set!', name, ['lambda', params, body]],
      ['apply', ['var', name], inits],
    ]], [['datum', null]]]
  }
  const pairs = bindings(node[1], pathFor(path, 1))
  const params = pairs.map(([key]) => key)
  const inits = pairs.map(([, expr], index) => expand(expr, pathFor(pathFor(path, 1), index)))
  const body = expand(bodyOf(node, 2, pathFor(path, 2)), pathFor(path, 2))
  return ['apply', ['lambda', params, body], inits]
}

function expandLetrec(node, path, expand) {
  const pairs = bindings(node[1], pathFor(path, 1))
  const params = pairs.map(([key]) => key)
  const body = expand(bodyOf(node, 2, pathFor(path, 2)), pathFor(path, 2))
  const sets = pairs.map(([, expr], index) => [
    'set!',
    params[index],
    expand(expr, pathFor(pathFor(path, 1), index)),
  ])
  return ['apply', ['lambda', params, ['begin', ...sets, body]], params.map(() => ['datum', null])]
}

function expandCond(node, path, expand) {
  if (node.length < 2) throw malformed('cond 至少需要一个分支', path)
  const clauses = []
  for (let i = 1; i < node.length; i++) {
    const clause = node[i]
    const clausePath = pathFor(path, i)
    if (!Array.isArray(clause) || clause.length < 2) throw malformed('cond 分支必须是 [test, expression...]', clausePath)
    const test = clause[0]
    const isElse = test === 'else'
    if (isElse && i !== node.length - 1) throw malformed('cond 的 else 必须是最后一个分支', clausePath)
    if (!isElse && typeof test === 'string') {
      throw malformed('cond 的 test 必须是表达式；else 只能单独出现', clausePath)
    }
    const expressions = clause.slice(1).map((expr, index) => expand(expr, pathFor(clausePath, index + 1)))
    clauses.push([isElse ? ['datum', true] : expand(test, pathFor(clausePath, 0)), expressions])
  }
  let cursor = ['datum', null]
  for (let i = clauses.length - 1; i >= 0; i--) {
    const [test, expressions] = clauses[i]
    cursor = ['if', test, expressions.length === 1 ? expressions[0] : ['begin', ...expressions], cursor]
  }
  return cursor
}

function expandNode(node, path) {
  if (!Array.isArray(node) || typeof node[0] !== 'string') return node
  const op = node[0]
  if (op === 'let') return expandLet(node, path, expandNode)
  if (op === 'letrec') {
    if (node.length < 3) throw malformed('letrec 需要绑定和函数体', path)
    return expandLetrec(node, path, expandNode)
  }
  if (op === 'cond') return expandCond(node, path, expandNode)
  const out = [op]
  for (let i = 1; i < node.length; i++) out.push(expandNode(node[i], pathFor(path, i)))
  return out
}

/**
 * Expand let/letrec/named let/cond into core forms. The input is not mutated.
 */
export function expandRule(source) {
  return expandNode(source, '$')
}
