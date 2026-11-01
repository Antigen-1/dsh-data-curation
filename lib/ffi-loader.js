// lib/ffi-loader.js — load FFI bindings from module definitions.
//
// Users provide module definitions via the `ffi` parameter of curation_pin:
//   { "my.module": { "module": "./ffi/my-module.js", "export": "processData", "arity": 2 } }
// The host dynamically imports these modules and creates an FfiRegistry.
import { pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { FfiRegistry } from './rules/ffi.js'

/**
 * Create an FfiRegistry from module definitions.
 * @param {Record<string, {module:string, export?:string, arity?:number}>} definitions
 * @param {string} cwd - project root for resolving relative module paths
 * @returns {Promise<FfiRegistry>}
 */
export async function createFfiRegistryFromDefinitions(definitions, cwd) {
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    return new FfiRegistry().seal()
  }
  const registry = new FfiRegistry()
  for (const [id, def] of Object.entries(definitions)) {
    if (!def || typeof def.module !== 'string') {
      throw new TypeError(`FFI binding ${id} 必须提供 module 路径`)
    }
    const modulePath = isAbsolute(def.module) ? def.module : resolve(cwd, def.module)
    const exportName = def.export ?? 'default'
    let mod
    try {
      mod = await import(pathToFileURL(modulePath).href)
    } catch (error) {
      throw new Error(`FFI binding ${id} 加载模块失败：${error.message}`)
    }
    const fn = mod[exportName]
    if (typeof fn !== 'function') {
      throw new TypeError(`FFI binding ${id}：模块 ${def.module} 的导出 ${exportName} 不是函数`)
    }
    registry.define(id, fn, { arity: def.arity })
  }
  return registry.seal()
}
