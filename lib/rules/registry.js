// lib/rules/registry.js — immutable, content-addressed rule collection.
import { createHash } from 'node:crypto'
import { compileRule } from './compiler.js'
import { RuleError } from './errors.js'
import { canonicalJson } from './signatures.js'

function freezeEntry(entry) {
  return Object.freeze(entry)
}

/**
 * A registry freezes rule sources, signatures and compiled hashes. After
 * `seal()` no new rule can be added, and the same id always resolves to the
 * same compiled rule.
 */
export class RuleRegistry {
  #entries = new Map()
  #sealed = false

  define(id, source, options = {}) {
    if (this.#sealed) throw new Error('rule registry 已封存，不能再注册')
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('rule id 必须是非空字符串')
    if (this.#entries.has(id)) throw new Error(`rule 重复注册：${id}`)
    const compiled = compileRule(source, options)
    const entry = freezeEntry({
      id,
      version: String(options.version ?? '1'),
      description: typeof options.description === 'string' ? options.description : '',
      signature: compiled.signature,
      hash: compiled.hash,
      ffiManifest: compiled.ffiManifest,
      compiled,
    })
    this.#entries.set(id, entry)
    return this
  }

  seal() {
    this.#sealed = true
    return this
  }

  get sealed() {
    return this.#sealed
  }

  has(id) {
    return this.#entries.has(id)
  }

  ids() {
    return [...this.#entries.keys()].sort()
  }

  get(id) {
    return this.#entries.get(id)?.compiled
  }

  describe(id) {
    const entry = this.#entries.get(id)
    if (!entry) throw new RuleError('UNKNOWN_RULE', `未知规则：${id}`, { path: '$' })
    return Object.freeze({
      id: entry.id,
      version: entry.version,
      description: entry.description,
      signature: entry.signature,
      hash: entry.hash,
      ffiManifest: [...entry.ffiManifest],
      nodeCount: entry.compiled.nodeCount,
      maxDepth: entry.compiled.maxDepth,
    })
  }

  entries() {
    return this.ids().map((id) => this.describe(id))
  }

  hash() {
    const payload = this.ids().map((id) => [id, this.describe(id).hash])
    return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`
  }

  async call(id, args = [], runtime = {}) {
    return (await this.callWithEffects(id, args, runtime)).result
  }

  async callWithEffects(id, args = [], runtime = {}) {
    const entry = this.#entries.get(id)
    if (!entry) throw new RuleError('UNKNOWN_RULE', `未知规则：${id}`, { path: '$' })
    try {
      const out = await entry.compiled.invokeWithEffects(args, runtime)
      return Object.freeze({ ruleId: id, version: entry.version, hash: entry.hash, ...out })
    } catch (error) {
      if (error instanceof RuleError) {
        if (!error.ruleId) error.ruleId = id
        if (!error.ruleVersion) error.ruleVersion = entry.version
      }
      throw error
    }
  }
}
