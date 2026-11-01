// lib/rules/limits.js — bounded execution defaults for the rules evaluator.
export const DEFAULT_LIMITS = Object.freeze({
  maxAstNodes: 20_000,
  maxAstDepth: 256,
  maxFuel: 10_000_000,
  timeoutMs: 5_000,
  maxCallDepth: 512,
  maxOutputBytes: 1_000_000,
})

const INTEGER_LIMITS = new Set(['maxAstNodes', 'maxAstDepth', 'maxFuel', 'maxCallDepth', 'maxOutputBytes'])

export function normalizeLimits(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('limits 必须是 object')
  }
  const out = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULT_LIMITS)) throw new TypeError(`未知的资源限制：${key}`)
    if (INTEGER_LIMITS.has(key)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} 必须是正整数`)
    } else if (key === 'timeoutMs') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${key} 必须是正数`)
      }
    }
    out[key] = value
  }
  return Object.freeze(out)
}
