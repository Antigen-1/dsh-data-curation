const { parentPort, workerData } = require('node:worker_threads')

let runtime = null
let closing = false
let activeCommand = null

function errorPayload (error) {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/.exec(message)
  return {
    code: error && error.code ? String(error.code) : (match?.[1] ?? 'E-TENANT-WORKER'),
    message,
  }
}

function send (message) {
  if (parentPort) parentPort.postMessage(message)
}

async function init () {
  const { SchemeV2Runtime } = await import('../v2/loader.js')
  runtime = await SchemeV2Runtime.open(workerData.pin, workerData.options)
  send({
    type: 'ready',
    tenantId: workerData.tenantId,
    info: {
      plugins: runtime.plugins?.length ?? 0,
      programs: runtime.programs?.length ?? 0,
      rules: runtime.rules?.length ?? 0,
    },
  })
}

async function runCommand (message) {
  if (!runtime) throw Object.assign(new Error('tenant runtime is not open'), { code: 'E-TENANT-CLOSED' })
  const payload = message.payload ?? {}
  switch (message.command) {
    case 'call':
      return runtime.call(payload.ruleId, payload.args ?? [], message.options ?? {})
    case 'callRule':
      return runtime.callRule(payload.ruleId, payload.version, payload.args ?? [], message.options ?? {})
    case 'callPlugin':
      return runtime.callPlugin(payload.pluginId, payload.version, payload.procedure ?? 'entry', payload.args ?? [], message.options ?? {})
    case 'programResult':
      return runtime.programResult(payload.programId, payload.version)
    case 'metrics':
      return runtime.metrics()
    case 'gc':
      return runtime.gc(payload.timeoutMs)
    default:
      throw Object.assign(new Error(`unknown tenant command: ${message.command}`), { code: 'E-TENANT-COMMAND' })
  }
}

parentPort.on('message', async (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'close') {
    closing = true
    try {
      if (activeCommand) await activeCommand.catch(() => {})
      if (runtime) await runtime.close()
    } finally {
      send({ type: 'closed' })
      process.exit(0)
    }
    return
  }
  if (message.type !== 'command' || closing) return
  const task = runCommand(message)
  activeCommand = task
  try {
    const value = await task
    send({ type: 'result', id: message.id, ok: true, value })
  } catch (error) {
    send({ type: 'result', id: message.id, ok: false, error: errorPayload(error) })
  } finally {
    if (activeCommand === task) activeCommand = null
  }
})

init().catch((error) => {
  send({ type: 'init-error', error: errorPayload(error) })
  process.exit(1)
})
