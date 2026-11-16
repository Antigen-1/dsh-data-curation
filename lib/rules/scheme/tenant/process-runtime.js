import { SchemeV2Runtime } from '../v2/loader.js'

const DEFAULT_OPEN_TIMEOUT_MS = 30000
const DEFAULT_CLOSE_TIMEOUT_MS = 5000
const DEFAULT_COMMAND_TIMEOUT_MS = 30000

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function codeFromError (error) {
  if (error && typeof error.code === 'string' && error.code) return error.code
  const message = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+):/.exec(message)
  return match ? match[1] : 'E-TENANT-PROCESS'
}

export class ProcessTenantRuntime {
  constructor (manager, config, root) {
    this.manager = manager
    this.id = config.id
    this.root = root
    this.config = config
    this.maxQueue = Number.isInteger(config.maxQueue) ? config.maxQueue : manager.maxQueue
    this.commandTimeoutMs = Number.isSafeInteger(config.commandTimeoutMs)
      ? config.commandTimeoutMs
      : manager.commandTimeoutMs
    this.runtime = null
    this.status = 'opening'
    this.queue = []
    this.active = null
    this.nextRequestId = 1
    this.restartPromise = null
    this.terminating = false
  }

  async start () {
    this.status = 'opening'
    let timedOut = false
    const openTimeoutMs = this.config.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    let openTimer
    const timeoutPromise = new Promise((resolve, reject) => {
      openTimer = setTimeout(() => {
        timedOut = true
        reject(codedError('E-TENANT-OPEN-TIMEOUT', `tenant ${this.id} open timed out`))
      }, openTimeoutMs)
      openTimer.unref?.()
    })
    const openPromise = SchemeV2Runtime.open(this.config.pin, {
      projectRoot: this.root,
      ffiModules: this.config.ffiModules,
      mounts: this.config.mounts,
      syncTimeoutMs: this.config.syncTimeoutMs,
      timeoutMs: this.config.timeoutMs ?? 5000,
      ffiTimeoutMs: this.config.ffiTimeoutMs ?? 1000,
      supervised: true,
      debugGcStats: this.config.debugGcStats === true,
      openTimeoutMs: this.config.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
      resource: this.config.resource,
      onEvent: (event) => this.manager.emit?.(this.id, event),
    }).then((runtime) => {
      if (timedOut) {
        runtime.close().catch(() => {})
        throw codedError('E-TENANT-OPEN-TIMEOUT', `tenant ${this.id} open timed out`)
      }
      return runtime
    })
    try {
      this.runtime = await Promise.race([openPromise, timeoutPromise])
      this.status = 'ready'
    } catch (error) {
      this.status = 'crashed'
      throw error
    } finally {
      clearTimeout(openTimer)
    }
  }

  get pid () {
    return this.runtime?.vm?.pid ?? null
  }

  _rejectAll (error) {
    if (this.active) {
      clearTimeout(this.active.timer)
      this.active.reject(error)
      this.active = null
    }
    for (const pending of this.queue.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  _enqueue (command, payload, options = {}) {
    if (this.status === 'closed' || this.status === 'closing') {
      return Promise.reject(codedError('E-TENANT-CLOSED', `tenant ${this.id} is closed`))
    }
    if (this.status === 'restarting') {
      return Promise.reject(codedError('E-TENANT-RESTART', `tenant ${this.id} is restarting`))
    }
    if (this.status === 'crashed') {
      return Promise.reject(codedError('E-TENANT-CRASH', `tenant ${this.id} has crashed`))
    }
    if (this.status !== 'ready') {
      return Promise.reject(codedError('E-TENANT-OPEN', `tenant ${this.id} is not ready`))
    }
    if (this.active && this.queue.length >= this.maxQueue) {
      return Promise.reject(codedError('E-TENANT-BUSY', `tenant ${this.id} queue is full`))
    }
    return new Promise((resolve, reject) => {
      const pending = { id: this.nextRequestId++, command, payload, options, resolve, reject, timer: null }
      pending.timer = setTimeout(() => this._onTimeout(pending), this.commandTimeoutMs)
      pending.timer.unref?.()
      this.queue.push(pending)
      this._drain()
    })
  }

  _onTimeout (pending) {
    if (this.active !== pending) {
      const index = this.queue.indexOf(pending)
      if (index < 0) return
      this.queue.splice(index, 1)
      clearTimeout(pending.timer)
      pending.reject(codedError('E-TENANT-TIMEOUT', `tenant ${this.id} command waited too long`))
      return
    }
    this.active = null
    clearTimeout(pending.timer)
    pending.reject(codedError('E-TENANT-TIMEOUT', `tenant ${this.id} command timed out`))
    this.status = 'crashed'
    this.runtime?.stopAutoRestart?.()
    this.runtime?.close?.().catch(() => {})
    this._rejectAll(codedError('E-TENANT-CRASH', `tenant ${this.id} was terminated after a command timeout`))
  }

  _drain () {
    if (this.active || this.status !== 'ready' || this.queue.length === 0) return
    const pending = this.queue.shift()
    this.active = pending
    this._run(pending).then((value) => {
      if (this.active !== pending) return
      clearTimeout(pending.timer)
      this.active = null
      pending.resolve(value)
      this._drain()
    }, (error) => {
      if (this.active !== pending) return
      clearTimeout(pending.timer)
      this.active = null
      const code = codeFromError(error)
      if (code === 'E-TIMEOUT') this.runtime?.stopAutoRestart?.()
      if (code.startsWith('E-RESOURCE-') || code === 'E-VM-DEAD' || code === 'E-VM-EXIT' || code === 'E-VM-CLOSED' || code === 'E-TIMEOUT') {
        this.status = 'crashed'
        pending.reject(error)
        this._rejectAll(codedError('E-TENANT-CRASH', `tenant ${this.id} is no longer alive`))
      } else {
        pending.reject(error)
        this._drain()
      }
    })
  }

  async _run (pending) {
    const { command, payload, options } = pending
    if (command === 'call') return await this.runtime.call(payload.ruleId, payload.args, options)
    if (command === 'callRule') return await this.runtime.callRule(payload.ruleId, payload.version, payload.args, options)
    if (command === 'callPlugin') return await this.runtime.callPlugin(payload.pluginId, payload.version, payload.procedure, payload.args, options)
    if (command === 'programResult') return await this.runtime.programResult(payload.programId, payload.version)
    if (command === 'metrics') {
      return {
        ...this.runtime.metrics(),
        isolation: 'process',
        pid: this.pid,
        resource: this.runtime.vm?.resourceStats?.() ?? null,
      }
    }
    if (command === 'gc') return await this.runtime.gc(payload.timeoutMs)
    if (command === 'gcStats') {
      const stats = await this.runtime.gcStats(payload.timeoutMs)
      return { ...stats, isolation: 'process', pid: this.pid }
    }
    throw codedError('E-TENANT-COMMAND', `unknown tenant command: ${command}`)
  }

  call (ruleId, args = [], options = {}) { return this._enqueue('call', { ruleId, args }, options) }
  callRule (ruleId, version, args = [], options = {}) { return this._enqueue('callRule', { ruleId, version, args }, options) }
  callPlugin (pluginId, version, procedure = 'entry', args = [], options = {}) { return this._enqueue('callPlugin', { pluginId, version, procedure, args }, options) }
  programResult (programId, version) { return this._enqueue('programResult', { programId, version }) }
  metrics () { return this._enqueue('metrics', {}) }
  gc (timeoutMs) { return this._enqueue('gc', { timeoutMs }) }
  gcStats (timeoutMs) { return this._enqueue('gcStats', { timeoutMs }) }

  async close () {
    if (this.status === 'closed') return
    this.status = 'closing'
    this._rejectAll(codedError('E-TENANT-CLOSED', `tenant ${this.id} is closing`))
    if (this.restartPromise) await this.restartPromise.catch(() => {})
    const timeout = this.config.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    try {
      await Promise.race([
        this.runtime?.close(),
        new Promise((resolve) => { const timer = setTimeout(resolve, timeout); timer.unref?.() }),
      ])
    } finally {
      this.runtime = null
      this.status = 'closed'
    }
  }

  async restart () {
    if (this.status === 'closed' || this.status === 'closing') throw codedError('E-TENANT-CLOSED', `tenant ${this.id} is closed`)
    if (this.restartPromise) throw codedError('E-TENANT-BUSY', `tenant ${this.id} is already restarting`)
    this.terminating = false
    this.restartPromise = this._restart()
    try { await this.restartPromise; return this } finally { this.restartPromise = null }
  }

  async _restart () {
    this.status = 'restarting'
    this._rejectAll(codedError('E-TENANT-RESTART', `tenant ${this.id} is restarting`))
    try {
      if (this.runtime) await this.runtime.restart()
      if (this.terminating) {
        await this.runtime?.close()
        this.status = 'closed'
        throw codedError('E-TENANT-CLOSED', `tenant ${this.id} was terminated during restart`)
      }
      this.status = 'ready'
    } catch (error) {
      this.status = 'crashed'
      this.runtime?.stopAutoRestart?.()
      await this.runtime?.close?.().catch(() => {})
      throw error
    }
  }

  async terminate () {
    if (this.status === 'closed' || this.status === 'closing') throw codedError('E-TENANT-CLOSED', `tenant ${this.id} is closed`)
    this.terminating = true
    if (this.restartPromise) await this.restartPromise.catch(() => {})
    this.status = 'crashed'
    this._rejectAll(codedError('E-TENANT-CRASH', `tenant ${this.id} was terminated`))
    this.runtime?.stopAutoRestart?.()
    this.runtime?.vm?.kill?.(codedError('E-TENANT-CRASH', `tenant ${this.id} was terminated`))
    return this
  }
}

export { DEFAULT_COMMAND_TIMEOUT_MS }
