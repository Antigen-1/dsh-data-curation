const { parentPort } = require('node:worker_threads')

const modules = new Map()

function errorPayload(error) {
  return {
    code: error && error.code ? String(error.code) : 'E-FFI-PROVIDER',
    message: error instanceof Error ? error.message : String(error),
  }
}

function resolveExport(module, name) {
  if (typeof module[name] === 'function') return module[name]
  if (module.default && typeof module.default[name] === 'function') return module.default[name]
  const error = new Error(`FFI module export not found: ${name}`)
  error.code = 'E-FFI-MODULE-EXPORT'
  throw error
}

parentPort.on('message', async (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'init') {
    try {
      for (const [namespace, url] of Object.entries(message.modules || {})) {
        modules.set(namespace, await import(url))
      }
      parentPort.postMessage({ type: 'ready' })
    } catch (error) {
      parentPort.postMessage({ type: 'init-error', error: errorPayload(error) })
    }
    return
  }
  if (message.type === 'call') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), message.timeoutMs)
    try {
      const module = modules.get(message.module)
      if (!module) {
        const error = new Error(`FFI module not loaded: ${message.module}`)
        error.code = 'E-FFI-MODULE'
        throw error
      }
      const fn = resolveExport(module, message.function)
      const value = await fn({ ...message.context, signal: controller.signal })
      parentPort.postMessage({ type: 'result', id: message.id, value })
    } catch (error) {
      const code = controller.signal.aborted ? 'E-FFI-TIMEOUT' : errorPayload(error).code
      parentPort.postMessage({
        type: 'result',
        id: message.id,
        error: { ...errorPayload(error), code },
      })
    } finally {
      clearTimeout(timer)
    }
  }
})
