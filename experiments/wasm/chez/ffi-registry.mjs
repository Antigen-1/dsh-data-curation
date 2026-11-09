export class FfiError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'FfiError'
    this.code = code
  }
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/
const RETURNS = new Set(['none', 'number', 'string', 'boolean'])

function assertReturn(value, expected, key) {
  if (expected === 'none') {
    if (value !== undefined && value !== null) throw new FfiError('E-FFI-TYPE', `${key} returned a value`)
    return
  }
  if (typeof value !== expected) throw new FfiError('E-FFI-TYPE', `${key} must return ${expected}`)
  if (expected === 'number' && !Number.isFinite(value)) {
    throw new FfiError('E-FFI-TYPE', `${key} returned a non-finite number`)
  }
}

function assertJsonArg(value, depth = 0) {
  if (depth > 8) throw new FfiError('E-FFI-TYPE', 'argument nesting too deep')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FfiError('E-FFI-TYPE', 'number must be finite')
    return
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) return
  if (Array.isArray(value)) {
    for (const item of value) assertJsonArg(item, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) assertJsonArg(item, depth + 1)
    return
  }
  throw new FfiError('E-FFI-TYPE', 'FFI arguments must be JSON values')
}

export function validateFfiManifest(manifest) {
  if (!manifest || manifest.version !== 1 || typeof manifest.modules !== 'object') {
    throw new FfiError('E-FFI-MANIFEST', 'manifest must have version 1 and modules')
  }
  for (const [moduleName, module] of Object.entries(manifest.modules)) {
    if (!NAME.test(moduleName)) throw new FfiError('E-FFI-MANIFEST', `bad module name: ${moduleName}`)
    if (!module || typeof module.functions !== 'object') {
      throw new FfiError('E-FFI-MANIFEST', `module ${moduleName} has no functions`)
    }
    for (const [functionName, spec] of Object.entries(module.functions)) {
      if (!NAME.test(functionName)) {
        throw new FfiError('E-FFI-MANIFEST', `bad function name: ${functionName}`)
      }
      if (!Number.isInteger(spec.arity) || spec.arity < 0 || spec.arity > 8) {
        throw new FfiError('E-FFI-MANIFEST', `bad arity: ${moduleName}.${functionName}`)
      }
      const scalars = new Set(['number', 'string', 'boolean'])
      if (!Array.isArray(spec.args) || spec.args.length !== spec.arity ||
          spec.args.some((type) => !scalars.has(type))) {
        throw new FfiError('E-FFI-MANIFEST', `bad argument types: ${moduleName}.${functionName}`)
      }
      if (!RETURNS.has(spec.returns)) {
        throw new FfiError('E-FFI-MANIFEST', `bad return type: ${moduleName}.${functionName}`)
      }
      if (spec.mode !== 'sync' && spec.mode !== 'async') {
        throw new FfiError('E-FFI-MANIFEST', `bad mode: ${moduleName}.${functionName}`)
      }
      if (Object.prototype.hasOwnProperty.call(spec, 'path') || Object.prototype.hasOwnProperty.call(spec, 'module')) {
        throw new FfiError('E-FFI-MANIFEST', 'manifest may not contain host paths')
      }
    }
  }
  return manifest
}

export function createFfiRegistry({ manifest, handlers }) {
  validateFfiManifest(manifest)
  const logical = new Map()

  for (const [moduleName, functions] of Object.entries(manifest.modules)) {
    for (const [functionName, spec] of Object.entries(functions.functions)) {
      const key = `${moduleName}.${functionName}`
      const handler = handlers[key]
      if (typeof handler !== 'function') throw new FfiError('E-FFI-MISSING', `missing handler: ${key}`)
      logical.set(key, { ...spec, handler })
    }
  }

  return {
    call({ module, function: functionName, args = [] }) {
      const key = `${module}.${functionName}`
      const entry = logical.get(key)
      if (!entry) throw new FfiError('E-FFI-UNKNOWN', `unknown ffi: ${key}`)
      if (!Array.isArray(args) || args.length !== entry.arity) {
        throw new FfiError('E-FFI-ARITY', `arity mismatch: ${key}`)
      }
      for (let index = 0; index < args.length; index += 1) {
        assertJsonArg(args[index])
        const expected = entry.args[index]
        if (typeof args[index] !== expected) {
          throw new FfiError('E-FFI-TYPE', `argument ${index} must be ${expected}`)
        }
      }
      try {
        const result = entry.handler(args)
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).then((value) => {
            assertReturn(value, entry.returns, key)
            return value
          }).catch((error) => {
            throw error instanceof FfiError ? error : new FfiError('E-FFI-HOST', error.message)
          })
        }
        assertReturn(result, entry.returns, key)
        return result
      } catch (error) {
        throw error instanceof FfiError ? error : new FfiError('E-FFI-HOST', error.message)
      }
    },
    has: (module, functionName) => logical.has(`${module}.${functionName}`),
    mode: (module, functionName) => logical.get(`${module}.${functionName}`)?.mode ?? null,
  }
}
