// lib/rules/errors.js — structured errors for the experimental rules DSL.
export class RuleError extends Error {
  constructor(code, message, { path = '$', detail } = {}) {
    const suffix = path && path !== '$' ? `（路径：${path}）` : ''
    super(`${message}${suffix}`)
    this.name = 'RuleError'
    this.code = code
    this.path = path
    if (detail !== undefined) this.detail = detail
  }

  toJSON() {
    const out = { name: this.name, code: this.code, message: this.message, path: this.path }
    if (this.detail !== undefined) out.detail = this.detail
    return out
  }
}

export function jsonPath(segments = []) {
  return segments.reduce((path, part) => `${path}[${part}]`, '$')
}
