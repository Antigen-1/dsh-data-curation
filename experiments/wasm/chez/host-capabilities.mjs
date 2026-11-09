import { createHash } from 'node:crypto'

export class CapabilityError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function createHostCapabilities({ projectFiles = [], logSink = null } = {}) {
  const files = new Map(projectFiles.map((file) => [file.path, file.content]))
  const audit = []
  const logs = []

  function readProject(path) {
    if (typeof path !== 'string' || !path.startsWith('/project/')) {
      throw new CapabilityError('E-CAPABILITY-DENIED', 'path must be under /project')
    }
    if (path.includes('..') || path.includes('\\') || path.includes('//')) {
      throw new CapabilityError('E-CAPABILITY-DENIED', 'path traversal is not allowed')
    }
    if (!files.has(path)) {
      throw new CapabilityError('E-CAPABILITY-DENIED', `not in project allowlist: ${path}`)
    }
    return files.get(path)
  }

  function call(request) {
    const { requestId, ruleHash, capability, args = [] } = request
    const started = process.hrtime.bigint()
    let value
    let error = null
    try {
      if (capability === 'project.read') {
        value = readProject(args[0])
      } else if (capability === 'log.write') {
        const line = String(args[0] ?? '')
        if (line.length > 4096) throw new CapabilityError('E-CAPABILITY-DENIED', 'log line too long')
        logs.push({ requestId, ruleHash, line })
        if (logSink) logSink(line, { requestId, ruleHash })
        value = true
      } else if (capability === 'clock.now') {
        value = Date.now()
      } else {
        throw new CapabilityError('E-CAPABILITY-UNKNOWN', `unknown capability: ${capability}`)
      }
      return value
    } catch (caught) {
      error = caught instanceof CapabilityError ? caught.code : 'E-CAPABILITY'
      throw caught
    } finally {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6
      const entry = {
        requestId,
        ruleHash,
        capability,
        argsHash: sha256(canonicalJson(args)),
        resultHash: error ? null : sha256(canonicalJson(value)),
        durationMs,
        error,
        nondeterministic: capability === 'clock.now',
      }
      audit.push(entry)
    }
  }

  return {
    call,
    audit: () => audit.slice(),
    logs: () => logs.slice(),
    has: (path) => files.has(path),
  }
}
