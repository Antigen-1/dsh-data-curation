// Opt-in isolation: run a pure rule in a worker thread so a runaway evaluator
// can be terminated without blocking the host. Custom primitives, FFI,
// capabilities and effect journals are intentionally not available here.
import { Worker } from 'node:worker_threads'
import { RuleError } from './errors.js'
import { DEFAULT_LIMITS } from './limits.js'

export function runRuleIsolated(source, args = [], { limits = {}, timeoutMs = 2000, maxOutputBytes = 1_000_000, scheme = false, reader = {} } = {}) {
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits }
  const worker = new Worker(new URL('./sandbox-worker.js', import.meta.url))
  let settled = false
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      fn(value)
    }
    const timer = setTimeout(() => {
      finish(reject, new RuleError('TIMEOUT', `规则隔离执行超过 ${timeoutMs}ms，已终止`))
    }, timeoutMs)
    worker.on('message', (payload) => {
      if (payload?.ok) {
        let text
        try {
          text = JSON.stringify(payload.result)
        } catch {
          finish(reject, new RuleError('RULE_RESULT', '规则结果不是 JSON'))
          return
        }
        if (Buffer.byteLength(text) > maxOutputBytes) {
          finish(reject, new RuleError('OUTPUT_LIMIT', `规则结果超过 ${maxOutputBytes} 字节`))
          return
        }
        finish(resolve, payload.result)
        return
      }
      const e = payload?.error ?? {}
      const message = String(e.message ?? '规则隔离执行失败').replace(/（路径：.*）$/, '')
      finish(reject, new RuleError(e.code ?? 'RULE_ERROR', message, { path: e.path ?? '$' }))
    })
    worker.on('error', (error) => finish(reject, error))
    worker.on('exit', (code) => {
      if (!settled && code !== 0) finish(reject, new RuleError('RULE_WORKER_EXIT', `规则 worker 异常退出（code ${code}）`))
    })
    worker.postMessage({ source, args, limits: effectiveLimits, scheme, reader })
  })
}
