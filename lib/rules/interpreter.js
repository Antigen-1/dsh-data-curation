// lib/rules/interpreter.js — lexical closures, async trampoline and TCO.
import { Buffer } from 'node:buffer'
import { cloneJsonValue, pathFor } from './ast.js'
import { RuleError } from './errors.js'
import { emptyFfiRegistry } from './ffi.js'
import { normalizeLimits } from './limits.js'
import { createDefaultPrimitives, isTruthy } from './primitives.js'

const TAIL = Symbol('rules-tail-call')

class Environment {
  constructor(parent = null) {
    this.parent = parent
    this.bindings = new Map()
  }

  define(name, value) {
    this.bindings.set(name, { value })
  }

  lookup(name, path) {
    for (let env = this; env; env = env.parent) {
      const cell = env.bindings.get(name)
      if (cell) return cell.value
    }
    throw new RuleError('UNBOUND_VARIABLE', `未绑定变量：${name}`, { path })
  }

  assign(name, value, path) {
    for (let env = this; env; env = env.parent) {
      const cell = env.bindings.get(name)
      if (cell) {
        cell.value = value
        return
      }
    }
    throw new RuleError('UNBOUND_VARIABLE', `set! 目标未绑定：${name}`, { path })
  }
}

function tailCall(proc, args, path) {
  return { [TAIL]: true, proc, args, path }
}

function isTailCall(value) {
  return Boolean(value && typeof value === 'object' && value[TAIL])
}

function tick(state, path) {
  state.steps += 1
  if (state.steps > state.limits.maxFuel) {
    throw new RuleError('FUEL_EXHAUSTED', `执行步数超过上限 ${state.limits.maxFuel}`, { path })
  }
  if (state.steps % 256 === 0) checkDeadline(state, path)
}

function checkDeadline(state, path) {
  if (state.clock() > state.deadline) {
    throw new RuleError('TIMEOUT', `执行超过 ${state.limits.timeoutMs}ms 时间上限`, { path })
  }
}

function bindClosure(proc, args, path) {
  if (args.length !== proc.params.length) {
    throw new RuleError('ARITY_MISMATCH', `lambda 需要 ${proc.params.length} 个参数，实际 ${args.length} 个`, { path })
  }
  const env = new Environment(proc.env)
  proc.params.forEach((name, index) => env.define(name, args[index]))
  return env
}

async function callPrimitive(proc, args, state, path) {
  let cloned
  try {
    cloned = args.map((arg, index) => cloneJsonValue(arg, pathFor(pathFor(path, 2), index)))
  } catch (error) {
    if (error instanceof RuleError) {
      throw new RuleError('MALFORMED_AST', `primitive ${proc.id} 的参数必须是 JSON 值`, { path, detail: error.message })
    }
    throw error
  }
  const value = await state.primitives.call(proc.id, cloned, path, state.context)
  checkDeadline(state, path)
  return value
}

async function callClosure(proc, args, state, path) {
  state.callDepth += 1
  if (state.callDepth > state.limits.maxCallDepth) {
    state.callDepth -= 1
    throw new RuleError('DEPTH_LIMIT', `非尾调用深度超过上限 ${state.limits.maxCallDepth}`, { path })
  }
  try {
    const env = bindClosure(proc, args, path)
    let result = await evalNode(proc.body, env, state, true, pathFor(proc.path, 2))
    while (isTailCall(result)) {
      const next = result
      const nextEnv = bindClosure(next.proc, next.args, next.path)
      result = await evalNode(next.proc.body, nextEnv, state, true, pathFor(next.proc.path, 2))
    }
    return result
  } finally {
    state.callDepth -= 1
  }
}

async function applyProcedure(proc, args, state, tail, path) {
  if (proc?.kind === 'primitive') return callPrimitive(proc, args, state, path)
  if (proc?.kind === 'closure') {
    if (tail) {
      if (args.length !== proc.params.length) {
        throw new RuleError('ARITY_MISMATCH', `lambda 需要 ${proc.params.length} 个参数，实际 ${args.length} 个`, { path })
      }
      return tailCall(proc, args, path)
    }
    return callClosure(proc, args, state, path)
  }
  throw new RuleError('NOT_PROCEDURE', '尝试调用非 procedure 值', { path })
}

async function evalNode(node, env, state, tail, path) {
  tick(state, path)
  const op = node[0]
  switch (op) {
    case 'datum':
      return node[1]
    case 'var':
      return env.lookup(node[1], path)
    case 'primitive':
      return { kind: 'primitive', id: node[1] }
    case 'ffi': {
      const args = []
      for (let i = 2; i < node.length; i++) {
        args.push(await evalNode(node[i], env, state, false, pathFor(path, i)))
      }
      tick(state, path)
      checkDeadline(state, path)
      const value = await state.ffi.call(node[1], args, path)
      checkDeadline(state, path)
      return value
    }
    case 'if': {
      const condition = await evalNode(node[1], env, state, false, pathFor(path, 1))
      const branch = isTruthy(condition) ? 2 : 3
      return evalNode(node[branch], env, state, tail, pathFor(path, branch))
    }
    case 'set!': {
      const value = await evalNode(node[2], env, state, false, pathFor(path, 2))
      env.assign(node[1], value, path)
      return value
    }
    case 'lambda':
      return { kind: 'closure', params: node[1], body: node[2], env, path }
    case 'begin': {
      let result
      for (let i = 1; i < node.length; i++) {
        result = await evalNode(node[i], env, state, tail && i === node.length - 1, pathFor(path, i))
      }
      return result
    }
    case 'apply': {
      const proc = await evalNode(node[1], env, state, false, pathFor(path, 1))
      const args = []
      for (let i = 0; i < node[2].length; i++) {
        args.push(await evalNode(node[2][i], env, state, false, pathFor(pathFor(path, 2), i)))
      }
      return applyProcedure(proc, args, state, tail, path)
    }
    default:
      throw new RuleError('UNKNOWN_FORM', `未知形式：${op}`, { path })
  }
}

/**
 * Evaluate an already-checked rule AST with positional arguments.
 * The returned value is a defensive JSON clone enforced by the output budget.
 */
export async function evaluateRule(ast, args, options = {}) {
  if (!Array.isArray(args)) throw new RuleError('MALFORMED_ARGUMENTS', '规则调用参数必须是数组', { path: '$args' })
  const limits = normalizeLimits(options.limits)
  const primitives = options.primitives ?? createDefaultPrimitives()
  const ffi = options.ffi ?? emptyFfiRegistry()
  const clock = options.now ?? (() => Date.now())
  if (typeof clock !== 'function') throw new TypeError('now 必须是函数')
  const state = {
    limits,
    primitives,
    ffi,
    context: options.context ?? null,
    clock,
    steps: 0,
    callDepth: 0,
    deadline: clock() + limits.timeoutMs,
  }

  let clonedArgs
  try {
    clonedArgs = args.map((arg, index) => cloneJsonValue(arg, `$args[${index}]`))
  } catch (error) {
    if (error instanceof RuleError) {
      throw new RuleError('MALFORMED_ARGUMENTS', '规则调用参数必须是 JSON 值', { path: '$args', detail: error.message })
    }
    throw error
  }

  const root = await evalNode(ast, new Environment(null), state, true, '$')
  if (root?.kind !== 'closure') {
    throw new RuleError('RULE_MUST_BE_PROCEDURE', '规则源码必须是一个 lambda procedure', { path: '$' })
  }
  const result = await callClosure(root, clonedArgs, state, '$')
  let output
  try {
    output = cloneJsonValue(result, '$result')
  } catch (error) {
    if (error instanceof RuleError) {
      throw new RuleError('RULE_RESULT', '规则返回值必须是 JSON 值', { path: '$result', detail: error.message })
    }
    throw error
  }
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8')
  if (bytes > limits.maxOutputBytes) {
    throw new RuleError('OUTPUT_LIMIT', `规则返回值超过 ${limits.maxOutputBytes} 字节上限`, { path: '$result', detail: { bytes } })
  }
  return output
}
