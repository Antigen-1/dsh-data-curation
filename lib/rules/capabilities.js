// lib/rules/capabilities.js — explicit host capabilities and staged effects.
import { cloneJsonValue } from './ast.js'
import { RuleError } from './errors.js'

/**
 * Host-granted capability set. Rules can only call capabilities that the host
 * explicitly granted; there is no ambient fs/net/env/process access.
 */
export class CapabilitySet {
  #grants = new Map()
  #sealed = false

  grant(name, handler) {
    if (this.#sealed) throw new Error('capability set 已封存，不能再授予')
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('capability 名称必须是非空字符串')
    if (typeof handler !== 'function') throw new TypeError(`capability ${name} 必须提供函数`)
    if (this.#grants.has(name)) throw new Error(`capability 重复授予：${name}`)
    this.#grants.set(name, handler)
    return this
  }

  seal() {
    this.#sealed = true
    return this
  }

  has(name) {
    return this.#grants.has(name)
  }

  get sealed() {
    return this.#sealed
  }

  names() {
    return [...this.#grants.keys()].sort()
  }

  async call(name, request, path = '$') {
    const handler = this.#grants.get(name)
    if (!handler) {
      throw new RuleError('CAPABILITY_DENIED', `未授予 capability：${name}`, { path })
    }
    let result
    try {
      result = await handler(cloneJsonValue(request, path), { path })
    } catch (error) {
      if (error instanceof RuleError) throw error
      throw new RuleError('CAPABILITY_ERROR', `capability ${name} 执行失败：${error?.message ?? String(error)}`, { path })
    }
    try {
      return cloneJsonValue(result, path)
    } catch (error) {
      if (error instanceof RuleError) {
        throw new RuleError('CAPABILITY_RESULT', `capability ${name} 返回了非 JSON 值`, { path, detail: error.message })
      }
      throw error
    }
  }
}

/**
 * Effects are staged in memory. Nothing reaches a database or the filesystem
 * through this journal; the host decides whether and how to commit it.
 */
export class EffectJournal {
  #entries = []
  #next = 1

  stage(effect) {
    const value = cloneJsonValue(effect, '$.effect')
    const entry = Object.freeze({ seq: this.#next++, effect: value })
    this.#entries.push(entry)
    return Object.freeze({ staged: true, seq: entry.seq })
  }

  entries() {
    return cloneJsonValue(this.#entries, '$.effects')
  }

  clear() {
    this.#entries = []
    this.#next = 1
  }
}

export function createRuleContext({ capabilities, effects } = {}) {
  const caps = capabilities ?? new CapabilitySet().seal()
  if (caps?.sealed !== true) throw new TypeError('capabilities 必须是已封存的 CapabilitySet')
  const journal = effects ?? new EffectJournal()
  if (typeof journal.stage !== 'function') throw new TypeError('effects 必须是 EffectJournal')
  return Object.freeze({ capabilities: caps, effects: journal })
}
