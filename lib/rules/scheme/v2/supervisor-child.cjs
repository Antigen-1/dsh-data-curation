'use strict'

// Dedicated child process for one Wasm incarnation. The parent supervisor owns
// lifetime and timeouts; this process only forwards dispatch/resume requests to
// the worker-backed CvmClient.

let client = null
let heartbeatTimer = null
let active = false
const startedAt = Date.now()

function send (message) {
  if (process.connected) process.send(message)
}

function sendHeartbeat () {
  if (!client) return
  send({
    type: 'heartbeat',
    at: Date.now(),
    uptimeMs: Date.now() - startedAt,
    active,
    memory: client.metrics(),
  })
}

function startHeartbeat (intervalMs) {
  stopHeartbeat()
  heartbeatTimer = setInterval(sendHeartbeat, intervalMs)
  heartbeatTimer.unref?.()
}

function stopHeartbeat () {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

async function open (options) {
  const { CvmClient } = await import('./client.js')
  client = new CvmClient(options)
  await client.preloadFfiModules()
  await client.loaded
  send({ type: 'loaded', memory: client.metrics() })
  startHeartbeat(options.heartbeatIntervalMs ?? 1000)
}

process.on('message', async (message) => {
  try {
    if (message.type === 'open') {
      await open(message.options || {})
      return
    }
    if (message.type === 'close') {
      stopHeartbeat()
      if (client) await client.close()
      process.exit(0)
    }
    if (message.type === 'ffiBindings') {
      if (!client) return
      const bindings = new Map()
      for (const [subject, targets] of Object.entries(message.bindings || {})) {
        bindings.set(subject, new Set(targets))
      }
      client.ffiBindings = bindings
      return
    }
    if (message.type === 'sync-mounts') {
      if (!client) throw Object.assign(new Error('incarnation is not open'), { code: 'E-VM-DEAD' })
      const result = await client.syncMounts(message.timeoutMs, (progress) => {
        send({ type: 'sync-progress', id: message.id, progress })
      })
      send({ type: 'sync-result', id: message.id, result })
      return
    }
    if (message.type === 'programAllowlist') {
      if (!client) return
      client.allowedRuleHashes = new Set(message.allowed || [])
      client.programSubjects = new Map(message.subjects || [])
      return
    }
    if (message.type === 'context') {
      if (!client) return
      const context = message.context || {}
      client.currentRuleHash = context.ruleHash
      client.currentSubjectKind = context.subjectKind
      client.currentPluginId = context.pluginId
      return
    }
    if (message.type !== 'dispatch' && message.type !== 'resume') return
    if (!client) throw Object.assign(new Error('incarnation is not open'), { code: 'E-VM-DEAD' })
    active = true
    let text
    try {
      text = await client[message.type](message.payload, message.timeoutMs)
    } finally {
      active = false
    }
    send({
      type: 'response',
      id: message.id,
      text,
      memory: client.metrics(),
    })
  } catch (error) {
    if (message.type === 'sync-mounts') {
      send({
        type: 'sync-result',
        id: message.id,
        error: error && error.code ? error.code : 'E-MOUNT-SYNC',
        message: error && error.message ? error.message : String(error),
      })
    } else {
      send({
        type: 'error',
        id: message.id,
        code: error && error.code ? error.code : 'E-VM-ERROR',
        message: error && error.stack ? error.stack : String(error),
      })
    }
  }
})

process.on('disconnect', () => {
  if (client) client.close().finally(() => process.exit(0))
  else process.exit(0)
})
