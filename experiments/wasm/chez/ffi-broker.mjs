import { canonicalJson, sha256 } from './host-capabilities.mjs'

export class FfiBroker {
  constructor({ capabilities, ffi, resume, abort, timeoutMs = 300, incarnationId = null }) {
    this.capabilities = capabilities
    this.ffi = ffi
    this.resume = resume
    this.abort = abort
    this.timeoutMs = timeoutMs
    this.incarnationId = incarnationId
    this.audit = []
    this.seenRequestIds = new Set()
    this.pendingCancels = new Map()
  }

  async invoke(suspended) {
    if (suspended.kind === 'capability') {
      return this.capabilities.call({
        requestId: suspended.requestId,
        ruleHash: suspended.ruleHash,
        capability: suspended.target,
        args: suspended.args,
      })
    }
    if (suspended.kind === 'ffi') {
      const [module, functionName] = String(suspended.target).split('.')
      return this.ffi.call({ module, function: functionName, args: suspended.args })
    }
    throw new Error(`unknown suspended kind: ${suspended.kind}`)
  }

  async cancel(requestId) {
    const reject = this.pendingCancels.get(requestId)
    if (!reject) {
      throw Object.assign(new Error(`request is not pending: ${requestId}`), {
        code: 'E-FFI-NOT-PENDING',
      })
    }
    reject(Object.assign(new Error('cancelled'), { code: 'E-CANCELLED' }))
    return { requested: true, requestId }
  }

  async dispatch(suspended) {
    if (typeof suspended.requestId !== 'string' || suspended.requestId.length === 0) {
      throw Object.assign(new Error('requestId must be a non-empty string'), { code: 'E-FFI-REQUEST-ID' })
    }
    if (this.seenRequestIds.has(suspended.requestId)) {
      throw Object.assign(new Error(`requestId reused in incarnation: ${suspended.requestId}`), {
        code: 'E-FFI-REQUEST-REUSED',
      })
    }
    this.seenRequestIds.add(suspended.requestId)
    const started = process.hrtime.bigint()
    const entry = {
      requestId: suspended.requestId,
      incarnationId: this.incarnationId,
      ruleHash: suspended.ruleHash,
      kind: suspended.kind,
      target: suspended.target,
      argsHash: sha256(canonicalJson(suspended.args)),
      status: 'pending',
      error: null,
      durationMs: null,
      late: false,
    }
    this.audit.push(entry)
    let timedOut = false
    try {
      const work = Promise.resolve().then(() => this.invoke(suspended))
      work.then(
        (value) => {
          if (!timedOut) return
          entry.late = true
          entry.lateResultHash = sha256(canonicalJson(value))
        },
        (error) => {
          if (!timedOut) return
          entry.late = true
          entry.lateError = error && error.code ? error.code : 'E-FFI-HOST'
        },
      )
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'E-TIMEOUT' })), this.timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
      const cancelled = new Promise((_, reject) => {
        this.pendingCancels.set(suspended.requestId, reject)
      })
      let value
      try {
        value = await Promise.race([work, timeout, cancelled])
      } finally {
        this.pendingCancels.delete(suspended.requestId)
      }
      entry.status = 'ok'
      entry.resultHash = sha256(canonicalJson(value))
      const response = await this.resume(suspended.requestId, true, value)
      entry.durationMs = Number(process.hrtime.bigint() - started) / 1e6
      return { ok: true, value, response }
    } catch (error) {
      if (error && (error.code === 'E-TIMEOUT' || error.code === 'E-CANCELLED')) {
        // A blocked guest cannot be resumed safely after timeout/cancel: the
        // host must destroy the incarnation instead of feeding a late reply.
        timedOut = true
        entry.status = error.code === 'E-CANCELLED' ? 'cancelled' : 'timeout'
        entry.error = error.code
        entry.durationMs = Number(process.hrtime.bigint() - started) / 1e6
        let receipt = { terminated: false }
        let abortError = null
        if (this.abort) {
          try {
            receipt = (await this.abort(entry)) || { terminated: false }
          } catch (error) {
            abortError = error && error.code ? error.code : 'E-FFI-ABORT'
          }
        }
        return {
          ok: false,
          error: entry.error,
          abortRequested: Boolean(this.abort),
          terminated: receipt.terminated === true,
          abortError,
        }
      }
      entry.status = 'error'
      entry.error = error && error.code ? error.code : 'E-FFI-HOST'
      const response = await this.resume(suspended.requestId, false, entry.error)
      entry.durationMs = Number(process.hrtime.bigint() - started) / 1e6
      return { ok: false, error: entry.error, response }
    }
  }
}
