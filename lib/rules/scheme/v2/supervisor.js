import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { applySyncProgress, createSyncProgress, snapshotSyncProgress } from './sync-progress.js'
import { createRssSampler } from './resource-sampler.js'
import { parseGcStats } from './client.js'

const CHILD = fileURLToPath(new URL('./supervisor-child.cjs', import.meta.url))

const DEFAULTS = Object.freeze({
  heartbeatIntervalMs: 1000,
  heartbeatMisses: 3,
  rssSampleMs: 5000,
  rssSoftBytes: 384 * 1024 * 1024,
  rssHardBytes: 512 * 1024 * 1024,
  wasmSoftBytes: 448 * 1024 * 1024,
  wasmHardBytes: 512 * 1024 * 1024,
})

function validateResource (resource) {
  const positive = (key) => {
    if (!Number.isSafeInteger(resource[key]) || resource[key] < 1) {
      const error = new Error(`invalid resource option: ${key}`)
      error.code = 'E-RESOURCE-CONFIG'
      throw error
    }
  }
  positive('heartbeatIntervalMs')
  positive('heartbeatMisses')
  if (!Number.isSafeInteger(resource.rssSampleMs) || resource.rssSampleMs < 0) {
    const error = new Error('invalid resource option: rssSampleMs')
    error.code = 'E-RESOURCE-CONFIG'
    throw error
  }
  for (const key of ['rssSoftBytes', 'rssHardBytes', 'wasmSoftBytes', 'wasmHardBytes']) positive(key)
  if (resource.rssHardBytes < resource.rssSoftBytes || resource.wasmHardBytes < resource.wasmSoftBytes) {
    const error = new Error('resource hard limit must be greater than or equal to soft limit')
    error.code = 'E-RESOURCE-CONFIG'
    throw error
  }
}

// Process-level supervisor for Scheme incarnations. FFI modules are loaded and
// executed inside the child; blocking providers terminate with the child.
export function evaluateHeartbeat ({
  dead = false,
  active = false,
  lastAt = null,
  strikes = 0,
  intervalMs,
  misses,
  now = Date.now(),
} = {}) {
  if (dead) return { strikes, kill: false, ageMs: null }
  if (active) return { strikes: 0, kill: false, ageMs: null }
  const ageMs = now - (lastAt ?? now)
  if (ageMs <= intervalMs * misses) return { strikes: 0, kill: false, ageMs }
  const nextStrikes = strikes + 1
  return { strikes: nextStrikes, kill: nextStrikes >= misses, ageMs }
}

export class CvmSupervisor {
  constructor (options = {}) {
    this.options = { ...options }
    this.options.bridgeToken = options.ffiModules ? (options.bridgeToken || randomUUID()) : null
    this.resource = { ...DEFAULTS, ...(options.resource || {}) }
    validateResource(this.resource)
    this.options.heartbeatIntervalMs = this.resource.heartbeatIntervalMs
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null
    this.rssSampler = options.rssSampler ?? createRssSampler()
    this.rssBytes = null
    this.rssHistory = []
    this.rssSampling = false
    this.lastHeartbeatAt = null
    this.lastHeartbeatActive = false
    this.heartbeatStrikes = 0
    this.heartbeatTimer = null
    this.rssTimer = null
    this.resourceKilled = false
    this.child = null
    this.pending = null
    this.nextId = 0
    this.closed = false
    this.disposed = false
    this.memory = null
    this._context = { ruleHash: null, subjectKind: null, pluginId: null }
    this.currentRuleHash = null
    this.currentSubjectKind = null
    this.currentPluginId = null
    this.bridgeToken = this.options.bridgeToken
    this.ffi = null
    this.ffiTargets = null
    this.programAllowlist = { allowed: [], subjects: [] }
    this.loaded = null
    this.loadedSettled = false
    this.loadedTimer = null
    this.restartPromise = null
    this.syncPending = new Map()
    this.nextSyncId = 0
    this.spawn()
  }

  emit (event, detail = {}) {
    try { this.onEvent?.({ at: Date.now(), event, ...detail }) } catch {}
  }

  resolveLoaded (message) {
    if (this.loadedSettled) return
    this.loadedSettled = true
    this.loadedResolve(message)
  }

  rejectLoaded (error) {
    if (this.loadedSettled) return
    this.loadedSettled = true
    this.loadedReject(error)
  }

  checkHeartbeat () {
    const result = evaluateHeartbeat({
      dead: this.dead,
      active: this.lastHeartbeatActive,
      lastAt: this.lastHeartbeatAt,
      strikes: this.heartbeatStrikes,
      intervalMs: this.resource.heartbeatIntervalMs,
      misses: this.resource.heartbeatMisses,
    })
    this.heartbeatStrikes = result.strikes
    if (!result.kill) return
    const error = new Error('supervised incarnation missed heartbeats')
    error.code = 'E-RESOURCE-HEARTBEAT'
    this.emit('resource-kill', { reason: error.code, ageMs: result.ageMs })
    this.resourceKilled = true
    this.kill(error)
  }

  startResourceMonitor () {
    this.stopResourceMonitor()
    this.lastHeartbeatAt = Date.now()
    this.heartbeatStrikes = 0
    const interval = this.resource.heartbeatIntervalMs
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), interval)
    this.heartbeatTimer.unref?.()
    if (!this.rssSampler || this.resource.rssSampleMs <= 0) return
    this.rssTimer = setInterval(() => { this.sampleRss().catch(() => {}) }, this.resource.rssSampleMs)
    this.rssTimer.unref?.()
    this.sampleRss().catch(() => {})
  }

  stopResourceMonitor () {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.rssTimer) clearInterval(this.rssTimer)
    this.heartbeatTimer = null
    this.rssTimer = null
  }

  async sampleRss () {
    if (this.dead || this.rssSampling || !this.child?.pid || !this.rssSampler) return
    const child = this.child
    const pid = child.pid
    this.rssSampling = true
    try {
      const bytes = await this.rssSampler(pid)
      if (this.dead || this.child !== child || !this.child?.pid) return
      if (!Number.isFinite(bytes) || bytes < 0) return
      this.rssBytes = bytes
      this.rssHistory.push({ at: Date.now(), bytes })
      if (this.rssHistory.length > 720) this.rssHistory.shift()
      if (bytes >= this.resource.rssHardBytes) {
        const error = new Error('supervised incarnation exceeded RSS limit')
        error.code = 'E-RESOURCE-RSS'
        this.emit('resource-kill', { reason: error.code, rss: bytes })
        this.resourceKilled = true
        this.kill(error)
      } else if (bytes >= this.resource.rssSoftBytes) {
        this.emit('resource-warning', { reason: 'E-RESOURCE-RSS-SOFT', rss: bytes })
      }
    } catch (error) {
      this.emit('sample-error', { message: error.message })
    } finally {
      this.rssSampling = false
    }
  }

  resourceStats () {
    return {
      rss: this.rssBytes,
      wasmBytes: this.memory?.wasmBytes ?? null,
      lastHeartbeatAt: this.lastHeartbeatAt,
      samples: this.rssHistory.length,
    }
  }

  setFfiBindings (bindings) {
    this.ffiBindings = bindings
    if (this.child && this.child.connected) {
      const serialized = {}
      for (const [subject, targets] of bindings || []) serialized[subject] = [...targets]
      try { this.child.send({ type: 'ffiBindings', bindings: serialized }) } catch {}
    }
  }

  setProgramAllowlist (allowedRuleHashes = new Set(), programSubjects = new Map()) {
    const allowed = [...allowedRuleHashes]
    const subjects = [...programSubjects.entries()]
    this.programAllowlist = { allowed, subjects }
    if (this.child && this.child.connected) {
      try { this.child.send({ type: 'programAllowlist', allowed, subjects }) } catch {}
    }
  }

  setContext (context) {
    this._context = { ...this._context, ...context }
    if (this.child && this.child.connected) {
      try { this.child.send({ type: 'context', context: this._context }) } catch {}
    }
  }

  get currentRuleHash () { return this._context.ruleHash }
  set currentRuleHash (value) { this.setContext({ ruleHash: value }) }
  get currentSubjectKind () { return this._context.subjectKind }
  set currentSubjectKind (value) { this.setContext({ subjectKind: value }) }
  get currentPluginId () { return this._context.pluginId }
  set currentPluginId (value) { this.setContext({ pluginId: value }) }

  spawn () {
    this.dead = false
    this.loadedSettled = false
    this.resourceKilled = false
    this.rssBytes = null
    this.rssHistory = []
    this.lastHeartbeatAt = null
    this.lastHeartbeatActive = false
    this.heartbeatStrikes = 0
    this.loaded = new Promise((resolve, reject) => {
      this.loadedResolve = resolve
      this.loadedReject = reject
    })
    this.loaded.catch(() => {})
    this.loadedTimer = setTimeout(() => {
      if (!this.loaded || this.dead) return
      const error = new Error('supervised incarnation did not initialize')
      error.code = 'E-VM-OPEN-TIMEOUT'
      this.kill(error)
    }, this.options.openTimeoutMs ?? 10000)
    if (typeof this.loadedTimer.unref === 'function') this.loadedTimer.unref()
    const child = fork(CHILD, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    this.child = child
    child.on('message', (message) => this.onMessage(message, child))
    child.on('error', (error) => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch {}
      }
      this.fail(error, child)
      this._notifyFatal(error)
    })
    child.on('exit', (code, signal) => {
      if (this.closed || this.child !== child) return
      const error = new Error(`supervised incarnation exited: ${code ?? signal}`)
      error.code = 'E-VM-EXIT'
      error.exitCode = code
      this.fail(error, child)
      this._notifyFatal(error)
    })
    try {
      child.send({ type: 'open', options: this.options })
      this.setContext(this._context)
      this.setProgramAllowlist(new Set(this.programAllowlist.allowed), new Map(this.programAllowlist.subjects))
    } catch (error) {
      this.fail(error, child)
      this._notifyFatal(error)
    }
    return this.loaded
  }

  onMessage (message, child) {
    if (this.child !== child) return
    if (message.type === 'sync-progress') {
      const waiter = this.syncPending.get(message.id)
      if (!waiter) return
      applySyncProgress(waiter.progress, message.progress)
      if (waiter.onProgress) {
        try {
          waiter.onProgress(message.progress)
        } catch {
          // Progress callbacks are diagnostics only.
        }
      }
      return
    }
    if (message.type === 'sync-result') {
      const waiter = this.syncPending.get(message.id)
      if (!waiter) return
      this.syncPending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) {
        const error = new Error(message.message || 'mount sync failed')
        error.code = message.error
        error.partial = snapshotSyncProgress(waiter.progress, message.error)
        waiter.reject(error)
      } else {
        waiter.resolve(message.result)
      }
      return
    }
    if (message.type === 'heartbeat') {
      this.lastHeartbeatAt = Date.now()
      this.lastHeartbeatActive = message.active === true
      this.heartbeatStrikes = 0
      if (message.memory) this.memory = message.memory
      this.emit('heartbeat', { active: message.active === true, rss: this.rssBytes })
      const wasmBytes = message.memory?.wasmBytes
      if (!this.resourceKilled && Number.isFinite(wasmBytes)) {
        if (wasmBytes >= this.resource.wasmHardBytes) {
          const error = new Error('supervised incarnation exceeded Wasm memory limit')
          error.code = 'E-RESOURCE-WASM'
          this.emit('resource-kill', { reason: error.code, wasmBytes })
          this.resourceKilled = true
          this.kill(error)
        } else if (wasmBytes >= this.resource.wasmSoftBytes) {
          this.emit('resource-warning', { reason: 'E-RESOURCE-WASM-SOFT', wasmBytes })
        }
      }
      return
    }
    if (message.type === 'loaded') {
      if (message.memory) this.memory = message.memory
      clearTimeout(this.loadedTimer)
      this.resolveLoaded(message)
      this.startResourceMonitor()
      return
    }
    if (message.type === 'error' && message.id === undefined) {
      const error = new Error(message.message || message.code || 'E-VM-ERROR')
      error.code = message.code || 'E-VM-ERROR'
      this.rejectLoaded(error)
      return
    }
    if (!this.pending || message.id !== this.pending.id) return
    const pending = this.pending
    this.pending = null
    clearTimeout(pending.timer)
    if (message.type === 'response') {
      if (message.memory) this.memory = message.memory
      pending.resolve(message)
    } else {
      const error = new Error(message.message || message.code || 'E-VM-ERROR')
      error.code = message.code || 'E-VM-ERROR'
      pending.reject(error)
    }
  }

  fail (error, child = this.child) {
    if (child !== this.child || this.dead) return
    this.dead = true
    this.closed = true
    this.stopResourceMonitor()
    clearTimeout(this.loadedTimer)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
    for (const waiter of this.syncPending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(Object.assign(error, { partial: snapshotSyncProgress(waiter.progress, error.code || 'E-VM-FAILED') }))
    }
    this.syncPending.clear()
    this.loadedReject(error)
  }

  request (type, payload, timeoutMs = 5000) {
    if (this.dead) {
      const error = new Error('supervised incarnation is closed')
      error.code = 'E-VM-DEAD'
      return Promise.reject(error)
    }
    if (this.pending) {
      const error = new Error('supervised incarnation already has an in-flight request')
      error.code = 'E-VM-BUSY'
      return Promise.reject(error)
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending || this.pending.id !== id) return
        const pending = this.pending
        this.pending = null
        const error = new Error(`${type} timeout`)
        error.code = 'E-TIMEOUT'
        this.kill(error)
        pending.reject(error)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending = { id, resolve, reject, timer }
      try {
        this.child.send({ type, id, payload, timeoutMs })
      } catch (error) {
        clearTimeout(timer)
        this.pending = null
        reject(error)
      }
    })
  }

  async dispatch (payload, timeoutMs) {
    await this.loaded
    const message = await this.request('dispatch', payload, timeoutMs)
    return message.text
  }

  async resume (payload, timeoutMs) {
    await this.loaded
    const message = await this.request('resume', payload, timeoutMs)
    return message.text
  }

  async syncMounts (timeoutMs = 10000, onProgress = null) {
    await this.loaded
    const id = ++this.nextSyncId
    const progress = createSyncProgress()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.syncPending.get(id)
        this.syncPending.delete(id)
        const error = new Error('mount sync timeout')
        error.code = 'E-MOUNT-SYNC-TIMEOUT'
        error.partial = snapshotSyncProgress(waiter?.progress ?? progress, 'timeout')
        reject(error)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.syncPending.set(id, { resolve, reject, timer, progress, onProgress })
      try {
        this.child.send({ type: 'sync-mounts', id, timeoutMs })
      } catch (error) {
        this.syncPending.delete(id)
        clearTimeout(timer)
        error.partial = snapshotSyncProgress(progress, 'send-error')
        reject(error)
      }
    })
  }

  async gc (timeoutMs = 5000) {
    const text = await this.dispatch('(request "gc" pin-gc)', timeoutMs)
    return { text, ...this.memory }
  }

  async gcStats (timeoutMs = 5000) {
    await this.dispatch('(request "debug-gc-stats" debug-gc-stats)', timeoutMs)
    const text = await this.dispatch('(request "gc-stats" pin-gc-stats)', timeoutMs)
    return { ...parseGcStats(text), pid: this.pid }
  }

  metrics () {
    return this.memory
      ? { ...this.memory, pid: this.pid, resource: this.resourceStats() }
      : { pid: this.pid, resource: this.resourceStats() }
  }

  get pid () {
    return this.child && this.child.pid
  }

  _notifyFatal (error) {
    if (typeof this.onFatal === 'function' && !this.disposed) {
      try { this.onFatal(error) } catch {}
    }
  }

  kill (reason) {
    if (this.dead) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.fail(error)
    if (this.child && this.child.pid) {
      try { this.child.kill('SIGKILL') } catch {}
    }
    this._notifyFatal(error)
  }

  async restart () {
    if (this.restartPromise) {
      const error = new Error('supervised incarnation is already restarting')
      error.code = 'E-VM-BUSY'
      throw error
    }
    if (this.disposed) {
      const error = new Error('supervised incarnation is closed')
      error.code = 'E-VM-DEAD'
      throw error
    }
    this.restartPromise = this._restart()
    try {
      return await this.restartPromise
    } finally {
      this.restartPromise = null
    }
  }

  async _restart () {
    this.stopResourceMonitor()
    clearTimeout(this.loadedTimer)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      const pending = this.pending
      this.pending = null
      const error = new Error('supervised incarnation restarted')
      error.code = 'E-VM-RESTART'
      pending.reject(error)
    }
    for (const waiter of this.syncPending.values()) {
      clearTimeout(waiter.timer)
      const error = new Error('supervised incarnation restarted')
      error.code = 'E-VM-RESTART'
      error.partial = snapshotSyncProgress(waiter.progress, 'restart')
      waiter.reject(error)
    }
    this.syncPending.clear()
    if (this.loadedReject) {
      const error = new Error('supervised incarnation restarted')
      error.code = 'E-VM-RESTART'
      this.rejectLoaded(error)
    }
    if (this.child && this.child.pid) {
      this.closed = true
      try { this.child.kill('SIGKILL') } catch {}
    }
    this.closed = false
    this.dead = false
    this.memory = null
    this.nextId = 0
    return this.spawn()
  }

  async close () {
    if (this.closed && !this.child) return
    this.stopResourceMonitor()
    const error = new Error('supervised incarnation is closed')
    error.code = 'E-VM-CLOSED'
    clearTimeout(this.loadedTimer)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      const pending = this.pending
      this.pending = null
      pending.reject(error)
    }
    for (const waiter of this.syncPending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(Object.assign(error, { partial: snapshotSyncProgress(waiter.progress, 'closed') }))
    }
    this.syncPending.clear()
    if (this.loadedReject) this.loadedReject(error)
    this.closed = true
    this.dead = true
    this.disposed = true
    const child = this.child
    this.child = null
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try { child.send({ type: 'close' }) } catch {}
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, 2000)
    timer.unref()
    await Promise.race([
      exited,
      new Promise((resolve) => {
        const fallback = setTimeout(resolve, 5000)
        fallback.unref()
      }),
    ])
    clearTimeout(timer)
  }
}
