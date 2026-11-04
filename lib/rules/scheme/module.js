// lib/rules/scheme/module.js — load-time module evaluator and rule registration.
//
// This evaluator is intentionally separate from the checked v1 interpreter:
// module code may hold closures while it builds descriptors, but every
// registered rule is closed into a self-contained v1 AST before compilation.
import { RuleError } from '../errors.js'
import { compileRule } from '../compiler.js'
import { createDefaultPrimitives } from '../primitives.js'
import { normalizeFfiRegistry } from '../ffi.js'
import { RuleRegistry } from '../registry.js'
import { cloneJsonValue } from '../ast.js'
import { PIN_RULES_VERSION, PIN_RULE_ROLES, normalizePinRules } from '../../pin-rules.js'
import { normalizeReaderOptions, readScheme, symbolName } from './reader.js'
import { Lowerer, createSchemeScope, lowerSchemeRule, standardLibraryBindings } from './lower.js'

const ROLE_SET = new Set(PIN_RULE_ROLES)

class ModuleEnv {
  constructor(parent = null) {
    this.parent = parent
    this.cells = new Map()
  }

  define(name, value) {
    if (this.cells.has(name)) throw new RuleError('DUPLICATE_DEFINE', `模块定义重复：${name}`, { path: '$' })
    const cell = { value }
    this.cells.set(name, cell)
    return cell
  }

  lookupCell(name) {
    for (let env = this; env; env = env.parent) {
      if (env.cells.has(name)) return env.cells.get(name)
    }
    return null
  }

  lookup(name) {
    const cell = this.lookupCell(name)
    if (!cell) throw new RuleError('UNBOUND_VARIABLE', `未绑定变量：${name}`, { path: '$' })
    if (cell.value === undefined) throw new RuleError('UNINITIALIZED_BINDING', `绑定尚未初始化：${name}`, { path: '$' })
    return cell.value
  }

  set(name, value) {
    const cell = this.lookupCell(name)
    if (!cell) throw new RuleError('UNBOUND_VARIABLE', `set! 目标未绑定：${name}`, { path: '$' })
    cell.value = value
  }
}

class ModuleClosure {
  constructor(params, body, env, name = '') {
    this.kind = 'closure'
    this.params = params
    this.body = body
    this.env = env
    this.name = name
  }
}

function primitiveValue(id) {
  return { kind: 'primitive', id }
}

function ffiValue(id, arity) {
  return { kind: 'ffi', id, arity }
}

function isClosure(value) {
  return value instanceof ModuleClosure
}

function expectString(value, label, code = 'SCHEME_REGISTER') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuleError(code, `${label} 必须是非空字符串`, { path: '$' })
  }
  return value
}

function pickReaderOptions(options) {
  const picked = {}
  for (const key of ['maxSourceBytes', 'maxTokens', 'maxDepth']) {
    if (Object.hasOwn(options, key)) picked[key] = options[key]
  }
  return picked
}

function expectRegisterOptions(value) {
  if (value === null || value === undefined) return { role: null, description: '', signature: undefined }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RuleError('SCHEME_REGISTER_OPTIONS', 'register-rule! options 必须是 object', { path: '$.options' })
  }
  const allowed = new Set(['role', 'description', 'signature'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RuleError('SCHEME_REGISTER_OPTIONS', `未知注册 option：${key}`, { path: `$.options.${key}` })
  }
  const role = value.role === undefined || value.role === null ? null : expectString(value.role, 'options.role', 'SCHEME_REGISTER_ROLE')
  const description = value.description === undefined ? '' : expectString(value.description, 'options.description', 'SCHEME_REGISTER_OPTIONS')
  let signature
  if (value.signature !== undefined) {
    if (value.signature === null || typeof value.signature !== 'object' || Array.isArray(value.signature)) {
      throw new RuleError('SCHEME_REGISTER_OPTIONS', 'options.signature 必须是 object', { path: '$.options.signature' })
    }
    signature = cloneJsonValue(value.signature, '$.options.signature')
  }
  return { role, description, signature }
}

function fixedPrimitiveProcedure(value, primitives) {
  const arity = primitives.arityOf(value.id)
  if (arity.min !== arity.max || !Number.isSafeInteger(arity.min)) {
    throw new RuleError('SCHEME_REGISTER_SOURCE', `变元 primitive ${value.id} 必须用固定元数 lambda 包装`, { path: '$.procedure' })
  }
  const params = Array.from({ length: arity.min }, (_, index) => `arg${index}`)
  return ['lambda', params, ['apply', ['primitive', value.id], params.map((name) => ['var', name])]]
}

function moduleError(message, path = '$') {
  return new RuleError('SCHEME_MODULE', message, { path })
}

async function evaluate(ast, env, context) {
  if (!Array.isArray(ast) || typeof ast[0] !== 'string') throw moduleError('模块 AST 节点无效')
  const op = ast[0]
  switch (op) {
    case 'datum':
      return ast[1]
    case 'var':
      return env.lookup(ast[1])
    case 'primitive':
      return primitiveValue(ast[1])
    case 'ffi':
      return context.ffi.call(ast[1], await evaluateMany(ast.slice(2), env, context))
    case 'ffi-value':
      return ffiValue(ast[1], context.ffi.arityOf(ast[1]))
    case 'if': {
      const test = await evaluate(ast[1], env, context)
      return evaluate(test !== false ? ast[2] : ast[3], env, context)
    }
    case 'set!': {
      const value = await evaluate(ast[2], env, context)
      env.set(ast[1], value)
      return null
    }
    case 'lambda':
      return new ModuleClosure(ast[1], ast[2], env)
    case 'begin': {
      let result = null
      for (const item of ast.slice(1)) result = await evaluate(item, env, context)
      return result
    }
    case 'let': {
      if (typeof ast[1] === 'string') {
        // Named let: ['let', name, bindings, body]. The name is recursive and
        // visible only inside the body and the parameter bindings.
        const name = ast[1]
        const bindings = ast[2]
        const child = new ModuleEnv(env)
        const cell = child.define(name, undefined)
        const values = []
        for (const [, init] of bindings) values.push(await evaluate(init, env, context))
        const closure = new ModuleClosure(bindings.map(([bindingName]) => bindingName), ast[3], child, name)
        cell.value = closure
        bindings.forEach(([bindingName], index) => child.define(bindingName, values[index]))
        return evaluate(ast[3], child, context)
      }
      const bindings = ast[1]
      const child = new ModuleEnv(env)
      const values = []
      for (const [, init] of bindings) values.push(await evaluate(init, env, context))
      bindings.forEach(([name], index) => child.define(name, values[index]))
      return evaluate(ast[2], child, context)
    }
    case 'letrec': {
      const bindings = ast[1]
      const child = new ModuleEnv(env)
      for (const [name] of bindings) child.define(name, undefined)
      const values = []
      for (const [, init] of bindings) values.push(await evaluate(init, child, context))
      bindings.forEach(([name], index) => { child.lookupCell(name).value = values[index] })
      return evaluate(ast[2], child, context)
    }
    case 'apply':
      return apply(await evaluate(ast[1], env, context), await evaluateMany(ast[2], env, context), context)
    case 'module-register': {
      const id = await evaluate(ast[1], env, context)
      const version = await evaluate(ast[2], env, context)
      const source = await evaluate(ast[3], env, context)
      const options = await evaluate(ast[4], env, context)
      return context.onRegister({ id, version, source, options })
    }
    default:
      throw moduleError(`模块求值器不支持 ${op}`)
  }
}

async function evaluateMany(asts, env, context) {
  const values = []
  for (const ast of asts) values.push(await evaluate(ast, env, context))
  return values
}

async function apply(operator, args, context) {
  if (operator instanceof ModuleClosure) {
    if (operator.params.length !== args.length) {
      throw new RuleError('ARITY_MISMATCH', `模块过程需要 ${operator.params.length} 个参数，实际 ${args.length}`, { path: '$' })
    }
    const child = new ModuleEnv(operator.env)
    operator.params.forEach((name, index) => child.define(name, args[index]))
    return evaluate(operator.body, child, context)
  }
  if (operator?.kind === 'primitive') {
    return context.primitives.call(operator.id, args)
  }
  if (operator?.kind === 'ffi') {
    return context.ffi.call(operator.id, args)
  }
  throw moduleError('模块调用目标不是过程')
}

function symbolDatum(name, span = null) {
  return { kind: 'symbol', value: name, span }
}

function listDatum(items, span = null) {
  return { kind: 'list', items, span }
}

function flattenTopLevel(datums) {
  const out = []
  for (const datumValue of datums) {
    if (datumValue.kind === 'directive') continue
    if (formNameIs(datumValue, 'begin')) {
      out.push(...flattenTopLevel(datumValue.items.slice(1)))
    } else {
      out.push(datumValue)
    }
  }
  return out
}

function formNameIs(datumValue, name) {
  return datumValue?.kind === 'list' && symbolName(datumValue.items[0]) === name
}

function parseDefinition(datumValue) {
  if (!formNameIs(datumValue, 'define')) return null
  const items = datumValue.items
  if (items.length < 3) throw moduleError('define 需要名称与表达式', '$')
  const target = items[1]
  if (target.kind === 'symbol') {
    if (items.length !== 3) throw moduleError('变量 define 只能有一个表达式', '$')
    return { name: target.value, expression: items[2], span: datumValue.span }
  }
  if (target.kind !== 'list' || target.items.length === 0 || target.items[0].kind !== 'symbol') {
    throw moduleError('define 目标必须是标识符或 (name params...)', '$')
  }
  const name = target.items[0].value
  const params = target.items.slice(1)
  if (params.some((param) => param.kind !== 'symbol')) throw moduleError('函数参数必须是标识符', '$')
  const lambda = listDatum([
    symbolDatum('lambda', target.span),
    listDatum(params, target.span),
    ...items.slice(2),
  ], datumValue.span)
  return { name, expression: lambda, span: datumValue.span }
}

/**
 * Evaluate a Scheme module. Definitions are sequential and may refer to any
 * earlier or (for closures invoked later) later module binding through the
 * shared module environment. Registration is a load-time side effect only.
 */
export async function evaluateSchemeModule(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Scheme 模块源码必须是字符串')
  const readerOptions = normalizeReaderOptions(options.reader ?? pickReaderOptions(options))
  const parsed = readScheme(source, readerOptions)
  const forms = flattenTopLevel(parsed.datums)
  const definitions = new Map()
  let counter = 0
  for (const form of forms) {
    const definition = parseDefinition(form)
    if (!definition) continue
    if (definitions.has(definition.name)) throw moduleError(`模块定义重复：${definition.name}`, '$')
    counter += 1
    definitions.set(definition.name, `m__${definition.name}__${counter}`)
  }

  const ffi = normalizeFfiRegistry(options.ffi)
  const primitives = options.primitives ?? createDefaultPrimitives()
  if (primitives?.sealed !== true) throw new TypeError('module primitives 必须是已封存的 PrimitiveRegistry')
  const freeBindings = standardLibraryBindings()
  for (const [sourceName, internal] of definitions) freeBindings.set(sourceName, ['var', internal])
  const moduleEnv = new ModuleEnv()
  for (const internal of definitions.values()) moduleEnv.define(internal, undefined)
  const descriptors = []
  const sourceMaps = new Map()
  const usedRoles = new Set()

  const context = {
    ffi,
    primitives,
    onRegister({ id, version, source: sourceValue, options: rawOptions }) {
      const ruleId = expectString(id, 'rule id', 'SCHEME_REGISTER_ID')
      if (descriptors.some((item) => item.id === ruleId)) throw new RuleError('DUPLICATE_RULE', `rule 重复注册：${ruleId}`, { path: '$.id' })
      const normalizedOptions = expectRegisterOptions(rawOptions)
      const role = normalizedOptions.role
      if (role !== null && !ROLE_SET.has(role)) throw new RuleError('SCHEME_REGISTER_ROLE', `未知 pin role：${role}`, { path: '$.options.role' })
      if (role !== null && usedRoles.has(role)) throw new RuleError('DUPLICATE_RULE_ROLE', `pin role 重复：${role}`, { path: '$.options.role' })
      let ast
      if (isClosure(sourceValue)) {
        ast = new ClosureConverter().convertTarget(sourceValue)
      } else if (sourceValue?.kind === 'primitive') {
        ast = fixedPrimitiveProcedure(sourceValue, primitives)
      } else if (sourceValue?.kind === 'ffi') {
        throw new RuleError('SCHEME_REGISTER_SOURCE', 'FFI procedure 必须用 lambda 显式包装后注册', { path: '$.procedure' })
      } else {
        throw new RuleError('SCHEME_REGISTER_SOURCE', 'register-rule! 的 procedure 必须是固定元数 lambda 或固定元数 primitive', { path: '$.procedure' })
      }
      descriptors.push(Object.freeze({
        id: ruleId,
        version: expectString(version, 'rule version', 'SCHEME_REGISTER_VERSION'),
        role,
        description: normalizedOptions.description,
        signature: normalizedOptions.signature,
        source: ast,
      }))
      sourceMaps.set(ruleId, Object.freeze((context.activeSourceMap ?? []).map((entry) => Object.freeze({ ...entry }))))
      if (role !== null) usedRoles.add(role)
      return ruleId
    },
  }

  for (const form of forms) {
    const definition = parseDefinition(form)
    if (definition) {
      const internal = definitions.get(definition.name)
      const lowerer = new Lowerer({ freeBindings, allowRegister: true })
      const ast = lowerer.lower(definition.expression, createSchemeScope(), '$')
      context.activeSourceMap = lowerer.sourceMap
      const value = await evaluate(ast, moduleEnv, context)
      moduleEnv.set(internal, value)
      continue
    }
    const lowerer = new Lowerer({ freeBindings, allowRegister: true })
    const ast = lowerer.lower(form, createSchemeScope(), '$')
    context.activeSourceMap = lowerer.sourceMap
    await evaluate(ast, moduleEnv, context)
  }

  return {
    descriptors,
    diagnostics: [],
    definitions,
    sourceMap: Object.freeze(Object.fromEntries(sourceMaps)),
  }
}

function sanitize(name) {
  return String(name || 'fn').replace(/[^A-Za-z0-9_.$!?+*/<>=:-]/g, '_')
}

function dataClone(value) {
  return cloneJsonValue(value, '$capture')
}

/**
 * Close a module closure into a v1 AST. Captured module closures become a
 * letrec inside the registered lambda, captured data is frozen as datum nodes,
 * and captured primitives become primitive nodes.
 */
class ClosureConverter {
  #mapping = new Map()
  #bindings = []
  #counter = 0

  convertTarget(closure) {
    if (!isClosure(closure)) throw moduleError('注册 source 不是模块闭包')
    const lambda = this.#convertLambda(closure)
    if (this.#bindings.length === 0) return lambda
    return ['lambda', lambda[1], ['letrec', this.#bindings.map(([name, ast]) => [name, ast]), lambda[2]]]
  }

  #bindingFor(closure) {
    if (this.#mapping.has(closure)) return this.#mapping.get(closure)
    this.#counter += 1
    const name = `%captured__${sanitize(closure.name)}__${this.#counter}`
    this.#mapping.set(closure, name)
    const lambda = this.#convertLambda(closure)
    this.#bindings.push([name, lambda])
    return name
  }

  #convertLambda(closure) {
    const bound = new Set(closure.params)
    return ['lambda', closure.params, this.#convertExpr(closure.body, closure.env, bound)]
  }

  #convertExpr(ast, env, bound) {
    if (typeof ast === 'string' || typeof ast === 'number' || typeof ast === 'boolean' || ast === null) return ast
    if (!Array.isArray(ast)) throw moduleError('捕获的 AST 不是数组')
    const op = ast[0]
    if (op === 'datum') return ['datum', dataClone(ast[1])]
    if (op === 'primitive') return ast
    if (op === 'var') {
      if (bound.has(ast[1])) return ast
      const cell = env.lookupCell(ast[1])
      if (!cell) return ast
      const value = cell.value
      if (isClosure(value)) return ['var', this.#bindingFor(value)]
      if (value?.kind === 'primitive') return ['primitive', value.id]
      if (value?.kind === 'ffi') {
        const arity = value.arity
        if (!arity || arity.min !== arity.max) {
          throw new RuleError('SCHEME_FFI_VALUE', `变参 FFI binding 不能被捕获为过程：${value.id}`, { path: '$' })
        }
        const params = Array.from({ length: arity.min }, (_, index) => `capturedArg${index}`)
        return ['lambda', params, ['ffi', value.id, ...params.map((name) => ['var', name])]]
      }
      if (value === undefined) throw moduleError(`捕获绑定尚未初始化：${ast[1]}`)
      try {
        return ['datum', dataClone(value)]
      } catch (error) {
        throw new RuleError('SCHEME_CAPTURE', `无法捕获模块值：${ast[1]}`, { path: '$', detail: error.message })
      }
    }
    if (op === 'apply') {
      return ['apply', this.#convertExpr(ast[1], env, bound), ast[2].map((arg) => this.#convertExpr(arg, env, bound))]
    }
    if (op === 'set!') {
      const target = ast[1]
      if (typeof target !== 'string') throw moduleError('捕获的 set! 目标不是变量')
      if (!bound.has(target)) {
        throw new RuleError('SCHEME_CAPTURE', `注册规则不能修改模块级绑定：${target}`, { path: '$set!' })
      }
      return ['set!', target, this.#convertExpr(ast[2], env, bound)]
    }
    if (op === 'lambda') {
      const nextBound = new Set(bound)
      for (const param of ast[1]) nextBound.add(param)
      return ['lambda', ast[1], this.#convertExpr(ast[2], env, nextBound)]
    }
    if (op === 'let' || op === 'let*' || op === 'letrec') {
      if (op === 'let*') {
        const bindings = ast[1]
        const bodyBound = new Set(bound)
        const converted = []
        for (const [name, init] of bindings) {
          const initAst = this.#convertExpr(init, env, bodyBound)
          converted.push([name, initAst])
          bodyBound.add(name)
        }
        let body = this.#convertExpr(ast[2], env, bodyBound)
        for (let index = converted.length - 1; index >= 0; index--) body = ['let', [converted[index]], body]
        return body
      }
      if (op === 'let' && typeof ast[1] === 'string') {
        const name = ast[1]
        const bindings = ast[2]
        const nextBound = new Set(bound)
        nextBound.add(name)
        for (const [bindingName] of bindings) nextBound.add(bindingName)
        return ['let', name,
          bindings.map(([bindingName, init]) => [bindingName, this.#convertExpr(init, env, bound)]),
          this.#convertExpr(ast[3], env, nextBound)]
      }
      const bindings = ast[1]
      const nextBound = new Set(bound)
      for (const [name] of bindings) nextBound.add(name)
      return [op, bindings.map(([name, init]) => [name, this.#convertExpr(init, env, op === 'let' ? bound : nextBound)]),
        this.#convertExpr(ast[2], env, nextBound)]
    }
    if (op === 'ffi') return ['ffi', ast[1], ...ast.slice(2).map((item) => this.#convertExpr(item, env, bound))]
    const out = [op]
    for (let index = 1; index < ast.length; index++) out.push(this.#convertExpr(ast[index], env, bound))
    return out
  }
}

/** Register one already-lowered or Scheme-source descriptor into a registry. */
export function registerRule(registry, descriptor, options = {}) {
  if (!(registry instanceof RuleRegistry)) throw new TypeError('registerRule 需要 RuleRegistry')
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new TypeError('rule descriptor 必须是对象')
  const allowedDescriptorKeys = new Set(['id', 'version', 'source', 'scheme', 'role', 'description', 'signature'])
  for (const key of Object.keys(descriptor)) {
    if (!allowedDescriptorKeys.has(key)) throw new RuleError('SCHEME_REGISTER_OPTIONS', `未知 rule descriptor 字段：${key}`, { path: `$.${key}` })
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('registerRule options 必须是对象')
  const allowedOptions = new Set(['ffi', 'primitives', 'limits', 'reader', 'signature', 'version', 'description', 'maxSourceBytes', 'maxTokens', 'maxDepth'])
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new RuleError('SCHEME_REGISTER_OPTIONS', `未知 registerRule option：${key}`, { path: `$.options.${key}` })
  }
  if (Object.hasOwn(descriptor, 'source') && Object.hasOwn(descriptor, 'scheme')) {
    throw new RuleError('SCHEME_REGISTER_SOURCE', 'descriptor.source 与 descriptor.scheme 只能提供一个', { path: '$.source' })
  }
  let ast = descriptor.source
  if (Object.hasOwn(descriptor, 'scheme')) {
    if (typeof descriptor.scheme !== 'string') throw new RuleError('SCHEME_REGISTER_SOURCE', 'descriptor.scheme 必须是 Scheme 源码', { path: '$.scheme' })
    ast = descriptor.scheme
  }
  if (typeof ast === 'string') {
    ast = lowerSchemeRule(ast, { reader: options.reader ?? pickReaderOptions(options) }).ast
  }
  if (!Array.isArray(ast)) throw new RuleError('SCHEME_REGISTER_SOURCE', '必须提供 descriptor.source AST/Scheme 源码或 descriptor.scheme', { path: '$.source' })
  if (descriptor.role !== undefined && descriptor.role !== null && !ROLE_SET.has(descriptor.role)) {
    throw new RuleError('SCHEME_REGISTER_ROLE', `未知 pin role：${descriptor.role}`, { path: '$.role' })
  }
  registry.define(descriptor.id, ast, {
    ffi: options.ffi,
    primitives: options.primitives,
    limits: options.limits,
    version: descriptor.version ?? options.version ?? '1',
    description: descriptor.description ?? options.description ?? '',
    signature: descriptor.signature ?? options.signature,
  })
  return registry
}

/** Convert loaded descriptors into the raw pin.rules shape (not yet normalized). */
export function pinRulesFromDescriptors(descriptors, { ffi = [] } = {}) {
  const rules = { version: PIN_RULES_VERSION, ffi: [] }
  const declared = new Map()
  for (const declaration of ffi) {
    if (typeof declaration === 'string') {
      if (!declaration.trim()) throw new RuleError('SCHEME_FFI_DECL', 'FFI 声明不能为空字符串', { path: '$.ffi' })
      declared.set(declaration, declaration)
      continue
    }
    if (!declaration || typeof declaration.id !== 'string' || !declaration.id.trim() || typeof declaration.module !== 'string') {
      throw new RuleError('SCHEME_FFI_DECL', 'FFI 声明对象必须包含 id 与 module', { path: '$.ffi' })
    }
    declared.set(declaration.id, { ...declaration })
  }
  for (const descriptor of descriptors) {
    const role = descriptor.role ?? null
    if (role === null) continue
    if (!ROLE_SET.has(role)) throw new RuleError('SCHEME_REGISTER_ROLE', `未知 pin role：${role}`, { path: '$.role' })
    if (rules[role]) throw new RuleError('DUPLICATE_RULE_ROLE', `pin role 重复：${role}`, { path: '$' })
    const spec = {
      id: descriptor.id,
      version: descriptor.version ?? '1',
      source: descriptor.source,
    }
    if (descriptor.signature) spec.signature = descriptor.signature
    rules[role] = spec
    for (const entry of descriptor.ffiManifest ?? []) {
      const id = typeof entry === 'string' ? entry : entry?.id
      if (typeof id !== 'string' || !id) throw new RuleError('SCHEME_FFI_DECL', '编译结果的 FFI manifest 缺少 id', { path: '$.ffiManifest' })
      if (!declared.has(id)) declared.set(id, id)
    }
  }
  rules.ffi = [...declared.values()].sort((a, b) => {
    const left = typeof a === 'string' ? a : a.id
    const right = typeof b === 'string' ? b : b.id
    return left.localeCompare(right)
  })
  return rules
}

/**
 * Load a Scheme module. Returns closed descriptors plus a sealed registry and
 * the raw pin.rules bridge. The caller can pass an existing unsealed registry
 * when multiple modules contribute rules.
 */
export async function loadSchemeRules(source, options = {}) {
  const { descriptors, diagnostics, sourceMap } = await evaluateSchemeModule(source, options)
  const registry = options.registry ?? new RuleRegistry()
  if (typeof registry.has !== 'function' || typeof registry.define !== 'function') {
    throw new TypeError('loadSchemeRules 的 registry 必须是 RuleRegistry')
  }
  if (registry.sealed) throw new RuleError('SCHEME_REGISTRY_SEALED', '目标 rule registry 已封存', { path: '$' })
  for (const descriptor of descriptors) {
    if (registry.has(descriptor.id)) {
      throw new RuleError('DUPLICATE_RULE', `rule 重复注册：${descriptor.id}`, { path: '$' })
    }
  }
  const compiledDescriptors = []
  for (const descriptor of descriptors) {
    const compiled = compileRule(descriptor.source, {
      ffi: options.ffi,
      primitives: options.primitives,
      limits: options.limits,
      signature: descriptor.signature ?? options.signature,
    })
    compiledDescriptors.push(Object.freeze({ ...descriptor, compiled, ffiManifest: compiled.ffiManifest }))
  }
  const rawPinRules = pinRulesFromDescriptors(compiledDescriptors, { ffi: options.ffiDeclarations ?? [] })
  const normalizedPin = normalizePinRules(rawPinRules, { ffi: options.ffi })
  if (!normalizedPin.ok) {
    throw new RuleError('SCHEME_PIN_RULES', 'Scheme 注册结果未通过 pin.rules 规范化', {
      path: '$.pinRules',
      detail: normalizedPin.errors,
    })
  }
  for (const descriptor of compiledDescriptors) {
    registry.define(descriptor.id, descriptor.source, {
      ffi: options.ffi,
      primitives: options.primitives,
      limits: options.limits,
      version: descriptor.version,
      description: descriptor.description,
      signature: descriptor.signature ?? options.signature,
    })
  }
  if (options.seal !== false && typeof registry.seal === 'function') registry.seal()
  return Object.freeze({
    descriptors: Object.freeze(compiledDescriptors),
    registry,
    pinRules: normalizedPin.rules,
    sourceMap,
    diagnostics: Object.freeze(diagnostics),
  })
}
