import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const CHILD = fileURLToPath(new URL('./supervisor-child.cjs', import.meta.url))

// Process-level supervisor for Scheme incarnations. FFI modules are loaded and
// executed inside the child; blocking providers terminate with the child.
export class CvmSupervisor {
  constructor (options = {}) {
    this.options = { ...options }
    this.options.bridgeToken = options.ffiModules ? (options.bridgeToken || randomUUID()) : null
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
    this.loadedTimer = null
    this.restartPromise = null
    this.spawn()
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
    })
    child.on('exit', (code, signal) => {
      if (this.closed || this.child !== child) return
      const error = new Error(`supervised incarnation exited: ${code ?? signal}`)
      error.code = 'E-VM-EXIT'
      error.exitCode = code
      this.fail(error, child)
    })
    try {
      child.send({ type: 'open', options: this.options })
      this.setContext(this._context)
      this.setProgramAllowlist(new Set(this.programAllowlist.allowed), new Map(this.programAllowlist.subjects))
    } catch (error) {
      this.fail(error, child)
    }
    return this.loaded
  }

  onMessage (message, child) {
    if (this.child !== child) return
    if (message.type === 'loaded') {
      if (message.memory) this.memory = message.memory
      clearTimeout(this.loadedTimer)
      this.loadedResolve(message)
      return
    }
    if (message.type === 'error' && message.id === undefined) {
      const error = new Error(message.message || message.code || 'E-VM-ERROR')
      error.code = message.code || 'E-VM-ERROR'
      this.loadedReject(error)
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
    clearTimeout(this.loadedTimer)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
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

  async gc (timeoutMs = 5000) {
    const text = await this.dispatch('(request "gc" pin-gc)', timeoutMs)
    return { text, ...this.memory }
  }

  metrics () {
    return this.memory ? { ...this.memory } : null
  }

  get pid () {
    return this.child && this.child.pid
  }

  kill (reason) {
    if (this.dead) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.fail(error)
    if (this.child && this.child.pid) {
      try { this.child.kill('SIGKILL') } catch {}
    }
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
    clearTimeout(this.loadedTimer)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      const pending = this.pending
      this.pending = null
      const error = new Error('supervised incarnation restarted')
      error.code = 'E-VM-RESTART'
      pending.reject(error)
    }
    if (this.loadedReject) {
      const error = new Error('supervised incarnation restarted')
      error.code = 'E-VM-RESTART'
      this.loadedReject(error)
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
    const error = new Error('supervised incarnation is closed')
    error.code = 'E-VM-CLOSED'
    clearTimeout(this.loadedTimer)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      const pending = this.pending
      this.pending = null
      pending.reject(error)
    }
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
