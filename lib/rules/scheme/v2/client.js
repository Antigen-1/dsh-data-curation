import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import tlv from './tlv.cjs'

const DEFAULT_ASSET_DIR = fileURLToPath(new URL('../../../../assets/chez-wasm/10.4.1-c/', import.meta.url))

const CAP = 1 << 20
const MASK = CAP - 1
const IN_POS = 0
const IN_READ = 1
const OUT_POS = 2
const OUT_READ = 3
const SHUTDOWN = 4
const MAX_BUFFERED = 256 * 1024

export class CvmClient {
  constructor({ guestFile, projectFiles = [], assetDir = DEFAULT_ASSET_DIR, ffi = null, ffiModules = null, ffiTimeoutMs = 1000, ffiTargets = null, openTimeoutMs = 10000, bridgeToken = null } = {}) {
    this.ffi = ffi
    this.ffiModules = ffiModules
    this.ffiTargets = ffiTargets ? new Set(ffiTargets) : null
    this.ffiBindings = null
    this.ffiTimeoutMs = ffiTimeoutMs
    this.openTimeoutMs = openTimeoutMs
    this.ffiWorker = null
    this.ffiReady = null
    this.ffiPending = new Map()
    this.ffiNextId = 0
    const hasFfi = Boolean(ffi || ffiModules)
    this.bridgeToken = hasFfi ? (bridgeToken || randomUUID()) : null
    this.bridge = hasFfi
      ? {
          control: new SharedArrayBuffer(8 * 4),
          input: new SharedArrayBuffer(CAP),
          output: new SharedArrayBuffer(CAP),
        }
      : null
    this.ctrl = this.bridge ? new Int32Array(this.bridge.control) : null
    this.inBuf = this.bridge ? new Uint8Array(this.bridge.input) : null
    this.outBuf = this.bridge ? new Uint8Array(this.bridge.output) : null
    this.outRead = 0
    this.buffered = Buffer.alloc(0)
    this.bridgeTimer = null
    this.bridgeChain = Promise.resolve()
    this.seenRequestIds = new Set()
    this.ridOrder = []
    this.activeControllers = new Set()
    this.currentRuleHash = null
    this.allowedRuleHashes = new Set()
    this.programSubjects = new Map()
    this.currentSubjectKind = null
    this.currentPluginId = null
    this.termination = null
    this.memory = null
    this.worker = new Worker(new URL('./worker.cjs', import.meta.url), {
      workerData: { guestFile, projectFiles, assetDir, bridge: this.bridge },
    })

    this.nextId = 0
    this.pending = new Map()
    this.dead = false
    this.closeReason = null
    this.loaded = new Promise((resolve, reject) => {
      this.loadedResolve = resolve
      this.loadedReject = reject
    })
    this.loaded.catch(() => {})
    this.worker.on('message', (message) => this.onMessage(message))
    this.worker.on('error', (error) => {
      this.kill(error)
      this.loadedReject(error)
    })
    this.worker.on('exit', (code) => {
      if (this.dead) return
      const error = new Error(`incarnation exited: ${code}`)
      error.code = 'E-VM-EXIT'
      error.exitCode = code
      this.kill(error)
      this.loadedReject(error)
    })
  }

  sendBridge (bytes) {
    let end = Atomics.load(this.ctrl, IN_POS)
    const read = Atomics.load(this.ctrl, IN_READ)
    if (end - read + bytes.length > CAP) {
      this.kill(Object.assign(new Error('host bridge input ring full'), { code: 'E-FFI-FRAME' }))
      return
    }
    for (const byte of bytes) {
      this.inBuf[end & MASK] = byte
      end += 1
    }
    Atomics.store(this.ctrl, IN_POS, end)
    Atomics.notify(this.ctrl, IN_POS)
  }

  drainBridge () {
    if (!this.bridge) return
    const end = Atomics.load(this.ctrl, OUT_POS)
    if (end <= this.outRead) return
    const chunk = Buffer.alloc(end - this.outRead)
    for (let index = 0; index < chunk.length; index += 1) {
      chunk[index] = this.outBuf[(this.outRead + index) & MASK]
    }
    this.outRead = end
    Atomics.store(this.ctrl, OUT_READ, this.outRead)
    Atomics.notify(this.ctrl, OUT_READ)
    this.buffered = Buffer.concat([this.buffered, chunk])
  }

  startBridge () {
    if (!this.bridge || this.bridgeTimer) return
    this.bridgeTimer = setInterval(() => {
      this.drainBridge()
      if (this.buffered.length > MAX_BUFFERED) {
        this.kill(Object.assign(new Error('FFI frame buffer limit exceeded'), { code: 'E-FFI-FRAME' }))
        return
      }
      for (;;) {
        if (this.buffered.length < 4) break
        const length = this.buffered.readUInt32BE(0)
        if (length > tlv.MAX_FRAME) {
          this.kill(Object.assign(new Error('FFI frame too large'), { code: 'E-FFI-FRAME' }))
          return
        }
        if (this.buffered.length < length + 4) break
        const frame = this.buffered.subarray(0, length + 4)
        this.buffered = this.buffered.subarray(length + 4)
        this.bridgeChain = this.bridgeChain
          .then(() => this.handleFfiFrame(frame))
          .catch((error) => {
            this.kill(Object.assign(new Error(`FFI frame handler failed: ${error && error.message ? error.message : error}`), { code: 'E-FFI-FRAME' }))
          })
      }
    }, 2)
    if (typeof this.bridgeTimer.unref === 'function') this.bridgeTimer.unref()
  }

  stopBridgeIfIdle () {
    if (this.pending.size > 0 || !this.bridgeTimer) return
    clearInterval(this.bridgeTimer)
    this.bridgeTimer = null
  }

  closeFfiWorker () {
    for (const waiter of this.ffiPending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(Object.assign(new Error('FFI module worker closed'), { code: 'E-FFI-MODULE' }))
    }
    this.ffiPending.clear()
    if (this.ffiWorker) {
      const worker = this.ffiWorker
      this.ffiWorker = null
      this.ffiReady = null
      worker.terminate()
    }
  }

  sendReply (value) {
    if (!this.bridge) return
    this.sendBridge(tlv.encode(value))
  }

  async preloadFfiModules () {
    if (!this.ffiModules) return
    if (this.ffiReady) return this.ffiReady
    this.ffiWorker = new Worker(new URL('./ffi-worker.cjs', import.meta.url))
    this.ffiReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error('FFI module preload timed out'), { code: 'E-FFI-MODULE' }))
      }, this.ffiTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.ffiWorker.once('message', (message) => {
        clearTimeout(timer)
        if (message && message.type === 'ready') {
          resolve()
        } else {
          const error = Object.assign(
            new Error(message?.error?.message || 'FFI module preload failed'),
            { code: message?.error?.code?.startsWith?.('E-FFI-') ? message.error.code : 'E-FFI-MODULE' },
          )
          reject(error)
        }
      })
      this.ffiWorker.once('error', (error) => {
        clearTimeout(timer)
        reject(Object.assign(new Error(`FFI module worker failed: ${error.message}`), { code: 'E-FFI-MODULE' }))
      })
      this.ffiWorker.on('message', (message) => this.onFfiWorkerMessage(message))
      this.ffiWorker.postMessage({ type: 'init', modules: this.ffiModules })
    })
    this.ffiReady.catch(() => {})
    return this.ffiReady
  }

  onFfiWorkerMessage (message) {
    if (!message || message.type !== 'result') return
    const waiter = this.ffiPending.get(message.id)
    if (!waiter) return
    this.ffiPending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) {
      waiter.reject(Object.assign(new Error(message.error.message || 'FFI provider failed'), { code: message.error.code || 'E-FFI-PROVIDER' }))
    } else {
      waiter.resolve(message.value)
    }
  }

  async callFfiModule (frame, context) {
    await this.preloadFfiModules()
    if (!this.ffiWorker) {
      throw Object.assign(new Error('FFI module worker is unavailable'), { code: 'E-FFI-MODULE' })
    }
    const moduleName = frame.target.split('.')[0]
    const functionName = frame.target.split('.').slice(1).join('.')
    const id = ++this.ffiNextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ffiPending.delete(id)
        const error = Object.assign(new Error(`FFI provider timed out: ${frame.target}`), { code: 'E-FFI-TIMEOUT' })
        reject(error)
        if (this.ffiWorker) {
          const worker = this.ffiWorker
          this.ffiWorker = null
          this.ffiReady = null
          worker.terminate()
        }
      }, this.ffiTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.ffiPending.set(id, { resolve, reject, timer })
      this.ffiWorker.postMessage({
        type: 'call',
        id,
        module: moduleName,
        function: functionName,
        timeoutMs: this.ffiTimeoutMs,
        context: { ...context, module: moduleName, function: functionName },
      })
    })
  }

  async handleFfiFrame (raw) {
    let frame
    try {
      frame = tlv.decode(raw)
    } catch (error) {
      if (error && (error.code === 'E-TLV-RANGE' || error.code === 'E-TLV-NUMBER')) {
        this.sendReply({ ok: false, error: error.code })
        return
      }
      this.kill(Object.assign(new Error('malformed FFI frame'), { code: 'E-FFI-FRAME' }))
      return
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      this.kill(Object.assign(new Error('malformed FFI frame'), { code: 'E-FFI-FRAME' }))
      return
    }
    const keys = Object.keys(frame).sort().join(',')
    if (keys !== 'args,id,kind,rid,rule,target,token' ||
        ![frame.id, frame.rid, frame.kind, frame.rule, frame.target, frame.token].every((value) => typeof value === 'string') ||
        !Array.isArray(frame.args)) {
      this.kill(Object.assign(new Error('malformed FFI frame'), { code: 'E-FFI-FRAME' }))
      return
    }
    if (!this.bridgeToken || frame.token !== this.bridgeToken) {
      this.kill(Object.assign(new Error('unauthenticated FFI frame'), { code: 'E-FFI-FRAME' }))
      return
    }
    // The guest may not choose its own rule identity; the host binds the
    // currently executing rule before dispatch and rejects any mismatch.
    // During program initialization the guest may only name a subject that
    // belongs to the verified program allowlist.
    let subject = this.currentRuleHash
    let subjectKind = this.currentSubjectKind
    let pluginId = this.currentPluginId
    if (subject === null && this.allowedRuleHashes.has(frame.rule)) {
      subject = frame.rule
      subjectKind = 'program'
      pluginId = null
    }
    if (subject === null) {
      this.kill(Object.assign(new Error('FFI frame rule mismatch'), { code: 'E-FFI-FRAME' }))
      return
    }
    if (frame.rule !== subject) {
      this.kill(Object.assign(new Error('FFI frame rule mismatch'), { code: 'E-FFI-FRAME' }))
      return
    }
    if (this.ffiBindings) {
      const allowed = this.ffiBindings.get(subject)
      if (!allowed) {
        this.sendReply({ ok: false, error: 'E-FFI-SUBJECT' })
        return
      }
      if (!allowed.has(frame.target)) {
        this.sendReply({ ok: false, error: 'E-FFI-TARGET' })
        return
      }
    } else if (!this.ffiTargets || !this.ffiTargets.has(frame.target)) {
      this.sendReply({ ok: false, error: 'E-FFI-NOT-DECLARED' })
      return
    }
    if (frame.kind !== 'ffi') {
      this.sendReply({ ok: false, error: 'E-FFI-UNKNOWN' })
      return
    }
    if (this.seenRequestIds.has(frame.rid)) {
      this.sendReply({ ok: false, error: 'E-FFI-REQUEST-REUSED' })
      this.kill(Object.assign(new Error('reused FFI requestId'), { code: 'E-FFI-REQUEST-REUSED' }))
      return
    }
    this.seenRequestIds.add(frame.rid)
    this.ridOrder.push(frame.rid)
    if (this.ridOrder.length > 1024) {
      this.seenRequestIds.delete(this.ridOrder.shift())
    }
    const controller = new AbortController()
    this.activeControllers.add(controller)
    let timer
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`FFI timeout: ${frame.target}`)
          error.code = 'E-TIMEOUT'
          reject(error)
        }, this.ffiTimeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
      const providerContext = {
        requestId: frame.rid,
        ruleHash: subject,
        subject,
        subjectKind,
        pluginId,
        programId: subjectKind === 'program' ? (this.programSubjects.get(subject) ?? null) : null,
        module: frame.target.split('.')[0],
        function: frame.target.split('.').slice(1).join('.'),
        target: frame.target,
        args: frame.args,
      }
      const provider = this.ffiModules
        ? this.callFfiModule(frame, providerContext)
        : this.ffi
          ? Promise.resolve().then(() => this.ffi.call({ ...providerContext, signal: controller.signal }))
          : Promise.reject(Object.assign(new Error('an ffiModules provider is required'), { code: 'E-FFI-MODULE-REQUIRED' }))
      const result = await Promise.race([provider, timeout])
      if (this.dead) return
      this.sendReply({ ok: true, value: result })
    } catch (error) {
      if (error && (error.code === 'E-TIMEOUT' || error.code === 'E-FFI-TIMEOUT')) {
        controller.abort()
        this.sendReply({ ok: false, error: 'E-FFI-TIMEOUT' })
        this.kill(Object.assign(new Error('FFI timeout'), { code: 'E-TIMEOUT' }))
        return
      }
      const code = error && typeof error.code === 'string' && error.code.startsWith('E-FFI-') ? error.code : 'E-FFI-HOST'
      if (!this.dead) this.sendReply({ ok: false, error: code })
    } finally {
      if (timer) clearTimeout(timer)
      this.activeControllers.delete(controller)
    }
  }

  kill (reason) {
    if (this.dead) return
    this.dead = true
    this.closeFfiWorker()
    this.closeReason = reason && reason.code ? reason.code : 'E-VM-CLOSED'
    if (this.bridgeTimer) {
      clearInterval(this.bridgeTimer)
      this.bridgeTimer = null
    }
    if (this.ctrl) {
      Atomics.store(this.ctrl, SHUTDOWN, 1)
      Atomics.notify(this.ctrl, IN_POS)
    }
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (!error.code) error.code = 'E-VM-CLOSED'
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
    this.loadedReject(error)
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    if (!this.termination) this.termination = this.worker.terminate()
  }

  onMessage(message) {
    if (message.type === 'exit') {
      const error = new Error(`incarnation exited: ${message.code}`)
      error.code = 'E-VM-EXIT'
      error.exitCode = message.code
      this.kill(error)
      this.loadedReject(error)
      return
    }
    if (message.type === 'loaded') {
      if (message.memory) this.memory = message.memory
      this.loadedResolve(message)
      return
    }
    if (message.type === 'error' && message.id === undefined) {
      const detail = message.message && message.message.message
        ? message.message.message
        : (typeof message.message === 'string' ? message.message : JSON.stringify(message.message))
      this.loadedReject(new Error(`${detail}${message.stderr ? `\n${message.stderr}` : ''}`))
      return
    }
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if (message.memory) this.memory = message.memory
    if (message.type === 'response') waiter.resolve(message)
    else {
      const error = new Error(message.message || JSON.stringify(message))
      error.code = message.code || 'E-VM-ERROR'
      waiter.reject(error)
    }
  }

  request(type, payload, timeoutMs = 5000) {
    if (this.dead) {
      const error = new Error(`incarnation is closed: ${this.closeReason}`)
      error.code = 'E-VM-DEAD'
      return Promise.reject(error)
    }
    if (this.pending.size > 0) {
      const error = new Error('incarnation already has an in-flight request')
      error.code = 'E-VM-BUSY'
      return Promise.reject(error)
    }
    const id = ++this.nextId
    this.startBridge()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`${type} timeout`)
        error.code = 'E-TIMEOUT'
        this.kill(error)
        reject(error)
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          this.stopBridgeIfIdle()
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          this.stopBridgeIfIdle()
          reject(error)
        },
      })
      this.worker.postMessage({ type, id, payload })
    })
  }

  async _awaitLoaded() {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('incarnation did not become ready')
        error.code = 'E-VM-OPEN-TIMEOUT'
        reject(error)
      }, this.openTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      await Promise.race([this.loaded, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async dispatch(payload, timeoutMs) {
    await this._awaitLoaded()
    const message = await this.request('dispatch', payload, timeoutMs)
    return message.text
  }

  async resume(payload, timeoutMs) {
    const message = await this.request('resume', payload, timeoutMs)
    return message.text
  }

  async gc(timeoutMs = this.ffiTimeoutMs) {
    const text = await this.dispatch('(request "gc" pin-gc)', timeoutMs)
    return { text, ...this.memory }
  }

  metrics() {
    return this.memory ? { ...this.memory } : null
  }

  async close() {
    if (this.dead) {
      if (this.termination) await this.termination
      return
    }
    this.dead = true
    this.closeFfiWorker()
    this.closeReason = 'E-VM-CLOSED'
    const error = new Error('incarnation is closed')
    error.code = 'E-VM-CLOSED'
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
    this.loadedReject(error)
    if (this.bridgeTimer) {
      clearInterval(this.bridgeTimer)
      this.bridgeTimer = null
    }
    if (this.ctrl) {
      Atomics.store(this.ctrl, SHUTDOWN, 1)
      Atomics.notify(this.ctrl, IN_POS)
    }
    for (const waiter of this.pending.values()) {
      waiter.reject(error)
    }
    this.pending.clear()
    if (!this.termination) this.termination = this.worker.terminate()
    await this.termination
  }
}
