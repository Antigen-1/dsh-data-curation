import { mkdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

const TENANT_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const DEFAULT_OPEN_TIMEOUT_MS = 30000
const DEFAULT_CLOSE_TIMEOUT_MS = 5000
const DEFAULT_COMMAND_TIMEOUT_MS = 30000
const DEFAULT_MAX_QUEUE = 32

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeTenantRoot (base, id) {
  const root = resolve(base, 'tenants', id)
  const prefix = `${resolve(base)}${sep}`
  if (root !== resolve(base) && !root.startsWith(prefix)) {
    throw codedError('E-TENANT-ROOT', `tenant root escapes base: ${id}`)
  }
  return root
}

function normalizeFfiModules (ffiModules) {
  if (ffiModules === undefined || ffiModules === null) return null
  if (typeof ffiModules !== 'object' || Array.isArray(ffiModules)) {
    throw codedError('E-FFI-MODULE', 'ffiModules must be an object')
  }
  const normalized = Object.create(null)
  for (const [namespace, value] of Object.entries(ffiModules)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(namespace)) {
      throw codedError('E-FFI-MODULE', `invalid FFI module namespace: ${namespace}`)
    }
    const url = value instanceof URL ? value : new URL(value)
    if (url.protocol !== 'file:') {
      throw codedError('E-FFI-MODULE', `FFI module must use a file URL: ${namespace}`)
    }
    normalized[namespace] = url.href
  }
  return normalized
}

function codeFromError (error) {
  if (error && typeof error.code === 'string' && error.code) return error.code
  const message = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+):/.exec(message)
  return match ? match[1] : 'E-TENANT-WORKER'
}

function errorPayload (error) {
  return {
    code: codeFromError(error),
    message: error instanceof Error ? error.message : String(error),
  }
}

class TenantRuntime {
  constructor (manager, config, root) {
    this.manager = manager
    this.id = config.id
    this.root = root
    this.config = config
    this.maxQueue = Number.isInteger(config.maxQueue) ? config.maxQueue : manager.maxQueue
    this.worker = null
    this.status = 'opening'
    this.queue = []
    this.active = null
    this.nextRequestId = 1
    this.readyPromise = null
    this.readyResolve = null
    this.readyReject = null
    this.openTimer = null
    this.expectedExit = false
    this.restartPromise = null
    this.closedResolve = null
    this.commandTimeoutMs = Number.isSafeInteger(config.commandTimeoutMs)
      ? config.commandTimeoutMs
      : manager.commandTimeoutMs
  }

  async start () {
    this.status = 'opening'
    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady
      this.readyReject = rejectReady
    })
    const workerData = {
      tenantId: this.id,
      pin: this.config.pin,
      options: {
        projectRoot: this.root,
        ffiModules: normalizeFfiModules(this.config.ffiModules),
        timeoutMs: this.config.timeoutMs ?? 5000,
        ffiTimeoutMs: this.config.ffiTimeoutMs ?? 1000,
        supervised: this.config.supervised === true,
      },
    }
    this.worker = new Worker(new URL('./worker.cjs', import.meta.url), {
      workerData,
      resourceLimits: this.config.resourceLimits,
    })
    this.worker.on('message', (message) => this._onMessage(message))
    this.worker.on('error', (error) => this._onWorkerError(error))
    this.worker.on('exit', (code) => this._onWorkerExit(code))
    this.openTimer = setTimeout(() => {
      this._failOpening(codedError('E-TENANT-OPEN-TIMEOUT', `tenant ${this.id} did not open in time`))
    }, this.config.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS)
    this.openTimer.unref?.()
    await this.readyPromise
  }

  _clearOpenTimer () {
    if (this.openTimer) {
      clearTimeout(this.openTimer)
      this.openTimer = null
    }
  }

  _failOpening (error) {
    this._clearOpenTimer()
    this.status = 'crashed'
    if (this.readyReject) this.readyReject(error)
    this._rejectAll(error)
    this.worker?.terminate().catch(() => {})
  }

  _onMessage (message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'ready') {
      this._clearOpenTimer()
      if (this.status === 'closing' || this.status === 'closed') return
      this.status = 'ready'
      this.readyResolve?.(this)
      return
    }
    if (message.type === 'init-error') {
      const error = codedError(message.error?.code ?? 'E-TENANT-OPEN', message.error?.message ?? 'tenant failed to open')
      this._failOpening(error)
      return
    }
    if (message.type === 'result') {
      const pending = this.active
      if (!pending || pending.id !== message.id) return
      this.active = null
      this._clearPendingTimer(pending)
      if (message.ok) pending.resolve(message.value)
      else {
        const error = codedError(message.error?.code ?? 'E-TENANT-ERROR', message.error?.message ?? 'tenant command failed')
        if (error.code === 'E-TIMEOUT' || error.code === 'E-VM-DEAD' || error.code === 'E-VM-CLOSED' || error.code === 'E-VM-EXIT') {
          this.status = 'crashed'
          pending.reject(error)
          this._rejectAll(codedError('E-TENANT-CRASH', `tenant ${this.id} is no longer alive`))
          this._drain()
          return
        }
        pending.reject(error)
      }
      this._drain()
      return
    }
    if (message.type === 'closed') {
      this.status = 'closed'
      this.closedResolve?.()
      this.readyResolve?.(this)
    }
  }

  _onWorkerError (error) {
    if (this.expectedExit || this.status === 'crashed' || this.status === 'closed') return
    this._failWith(codedError('E-TENANT-CRASH', `tenant ${this.id} worker error: ${error.message}`))
  }

  _onWorkerExit (code) {
    this._clearOpenTimer()
    if (this.expectedExit || this.status === 'closed' || this.status === 'crashed') return
    this._failWith(codedError('E-TENANT-CRASH', `tenant ${this.id} worker exited with code ${code}`))
  }

  _failWith (error) {
    this.status = 'crashed'
    this.readyReject?.(error)
    this._rejectAll(error)
  }

  _clearPendingTimer (pending) {
    if (pending?.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
  }

  _rejectAll (error) {
    if (this.active) {
      this._clearPendingTimer(this.active)
      this.active.reject(error)
      this.active = null
    }
    for (const pending of this.queue.splice(0)) {
      this._clearPendingTimer(pending)
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
    return new Promise((resolvePromise, rejectPromise) => {
      const pending = {
        id: this.nextRequestId++,
        command,
        payload,
        options,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: null,
      }
      pending.timer = setTimeout(() => this._onCommandTimeout(pending), this.commandTimeoutMs)
      pending.timer.unref?.()
      this.queue.push(pending)
      this._drain()
    })
  }

  _onCommandTimeout (pending) {
    if (this.active !== pending) return
    this._clearPendingTimer(pending)
    this.active = null
    pending.reject(codedError('E-TENANT-TIMEOUT', `tenant ${this.id} command timed out`))
    this._failWith(codedError('E-TENANT-CRASH', `tenant ${this.id} was terminated after a command timeout`))
    this.worker?.terminate().catch(() => {})
  }

  _drain () {
    if (this.active || this.status !== 'ready' || this.queue.length === 0) return
    const pending = this.queue.shift()
    this.active = pending
    try {
      this.worker.postMessage({
        type: 'command',
        id: pending.id,
        command: pending.command,
        payload: pending.payload,
        options: pending.options,
      })
    } catch (error) {
      this.active = null
      this._clearPendingTimer(pending)
      pending.reject(codedError('E-TENANT-COMMAND', `tenant ${this.id} could not send command: ${error.message}`))
      this._drain()
    }
  }

  async call (ruleId, args = [], options = {}) {
    return this._enqueue('call', { ruleId, args }, options)
  }

  async callRule (ruleId, version, args = [], options = {}) {
    return this._enqueue('callRule', { ruleId, version, args }, options)
  }

  async callPlugin (pluginId, version, procedure = 'entry', args = [], options = {}) {
    return this._enqueue('callPlugin', { pluginId, version, procedure, args }, options)
  }

  async programResult (programId, version) {
    return this._enqueue('programResult', { programId, version })
  }

  async metrics () {
    return this._enqueue('metrics', {})
  }

  async gc (timeoutMs) {
    return this._enqueue('gc', { timeoutMs })
  }

  async close () {
    if (this.status === 'closed') return
    this.status = 'closing'
    this.expectedExit = true
    this._rejectAll(codedError('E-TENANT-CLOSED', `tenant ${this.id} is closing`))
    if (this.restartPromise) await this.restartPromise.catch(() => {})
    const worker = this.worker
    if (!worker) {
      this.status = 'closed'
      return
    }
    const closed = new Promise((resolveClose) => { this.closedResolve = resolveClose })
    let timer = null
    try {
      worker.postMessage({ type: 'close' })
      await Promise.race([
        closed,
        new Promise((resolveClose) => {
          timer = setTimeout(resolveClose, this.config.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (worker.exitCode === null) await worker.terminate().catch(() => {})
      this.status = 'closed'
      this.worker = null
      this.closedResolve = null
    }
  }

  async restart () {
    if (this.status === 'closed' || this.status === 'closing') {
      throw codedError('E-TENANT-CLOSED', `tenant ${this.id} is closed`)
    }
    if (this.restartPromise) throw codedError('E-TENANT-BUSY', `tenant ${this.id} is already restarting`)
    this.restartPromise = this._restart()
    try {
      await this.restartPromise
      return this
    } finally {
      this.restartPromise = null
    }
  }

  async _restart () {
    this.status = 'restarting'
    this._rejectAll(codedError('E-TENANT-RESTART', `tenant ${this.id} is restarting`))
    const old = this.worker
    this.expectedExit = true
    this.worker = null
    if (old) await old.terminate().catch(() => {})
    if (this.status === 'closing') throw codedError('E-TENANT-CLOSED', `tenant ${this.id} is closed`)
    this.expectedExit = false
    await this.start()
  }

  async terminate () {
    if (this.status === 'closed' || this.status === 'closing') {
      throw codedError('E-TENANT-CLOSED', `tenant ${this.id} is closed`)
    }
    if (this.restartPromise) await this.restartPromise.catch(() => {})
    const worker = this.worker
    this.status = 'crashed'
    this.expectedExit = true
    this.worker = null
    this._rejectAll(codedError('E-TENANT-CRASH', `tenant ${this.id} was terminated`))
    if (worker) await worker.terminate().catch(() => {})
    return this
  }
}

export class TenantManager {
  static async open (config) {
    if (!config || typeof config !== 'object') throw codedError('E-TENANT-CONFIG', 'tenant manager config is required')
    const projectRoot = resolve(config.projectRoot ?? process.cwd())
    if (!Array.isArray(config.tenants) || config.tenants.length === 0) {
      throw codedError('E-TENANT-CONFIG', 'at least one tenant is required')
    }
    if (config.tenants.length > (config.maxTenants ?? 64)) {
      throw codedError('E-TENANT-LIMIT', 'too many tenants')
    }
    const manager = new TenantManager(projectRoot, config)
    const ids = new Set()
    for (const tenant of config.tenants) {
      if (!tenant || typeof tenant.id !== 'string' || !TENANT_ID.test(tenant.id) || tenant.id.endsWith('.')) {
        throw codedError('E-TENANT-CONFIG', `invalid tenant id: ${tenant?.id}`)
      }
      if (tenant.maxQueue !== undefined && (!Number.isSafeInteger(tenant.maxQueue) || tenant.maxQueue < 0)) {
        throw codedError('E-TENANT-CONFIG', `invalid maxQueue for tenant: ${tenant.id}`)
      }
      if (tenant.commandTimeoutMs !== undefined &&
          (!Number.isSafeInteger(tenant.commandTimeoutMs) || tenant.commandTimeoutMs < 1)) {
        throw codedError('E-TENANT-CONFIG', `invalid commandTimeoutMs for tenant: ${tenant.id}`)
      }
      const canonicalId = tenant.id.toLowerCase()
      if (ids.has(canonicalId)) throw codedError('E-TENANT-CONFIG', `duplicate tenant id: ${tenant.id}`)
      ids.add(canonicalId)
      const root = normalizeTenantRoot(projectRoot, tenant.id)
      mkdirSync(root, { recursive: true })
      const runtime = new TenantRuntime(manager, { ...tenant, maxQueue: tenant.maxQueue ?? config.maxQueue }, root)
      manager.tenants.set(tenant.id, runtime)
    }
    try {
      await Promise.all([...manager.tenants.values()].map((tenant) => tenant.start()))
    } catch (error) {
      await manager.close().catch(() => {})
      throw error
    }
    return manager
  }

  constructor (projectRoot, config) {
    this.projectRoot = projectRoot
    const configuredQueue = config.maxQueue ?? DEFAULT_MAX_QUEUE
    if (!Number.isSafeInteger(configuredQueue) || configuredQueue < 0) {
      throw codedError('E-TENANT-CONFIG', 'maxQueue must be a non-negative integer')
    }
    const configuredTenants = config.maxTenants ?? 64
    if (!Number.isSafeInteger(configuredTenants) || configuredTenants < 1) {
      throw codedError('E-TENANT-CONFIG', 'maxTenants must be a positive integer')
    }
    const configuredTimeout = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 1) {
      throw codedError('E-TENANT-CONFIG', 'commandTimeoutMs must be a positive integer')
    }
    this.maxQueue = configuredQueue
    this.maxTenants = configuredTenants
    this.commandTimeoutMs = configuredTimeout
    this.tenants = new Map()
  }

  get (tenantId) {
    return this.tenants.get(tenantId) ?? null
  }

  require (tenantId) {
    const tenant = this.get(tenantId)
    if (!tenant) throw codedError('E-TENANT-ID', `unknown tenant: ${tenantId}`)
    return tenant
  }

  async call (tenantId, ruleId, args, options) {
    return this.require(tenantId).call(ruleId, args, options)
  }

  async callRule (tenantId, ruleId, version, args, options) {
    return this.require(tenantId).callRule(ruleId, version, args, options)
  }

  async callPlugin (tenantId, pluginId, version, procedure, args, options) {
    return this.require(tenantId).callPlugin(pluginId, version, procedure, args, options)
  }

  async programResult (tenantId, programId, version) {
    return this.require(tenantId).programResult(programId, version)
  }

  async metrics (tenantId) {
    return this.require(tenantId).metrics()
  }

  async gc (tenantId, timeoutMs) {
    return this.require(tenantId).gc(timeoutMs)
  }

  async restart (tenantId) {
    return this.require(tenantId).restart()
  }

  async terminate (tenantId) {
    return this.require(tenantId).terminate()
  }

  async closeTenant (tenantId) {
    const tenant = this.get(tenantId)
    if (!tenant) return
    await tenant.close()
    this.tenants.delete(tenantId)
  }

  list () {
    return [...this.tenants.values()].map((tenant) => ({
      id: tenant.id,
      root: tenant.root,
      status: tenant.status,
    }))
  }

  async close () {
    await Promise.all([...this.tenants.values()].map((tenant) => tenant.close().catch(() => {})))
    this.tenants.clear()
  }
}

export { errorPayload }
