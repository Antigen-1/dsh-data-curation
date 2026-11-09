import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const DEFAULT_ASSET_DIR = fileURLToPath(new URL('../../../../assets/chez-wasm/10.4.1-c/', import.meta.url))

const CAP = 1 << 20
const MASK = CAP - 1
const IN_POS = 0
const IN_READ = 1
const OUT_POS = 2
const OUT_READ = 3
const SHUTDOWN = 4
const FFI_FRAME_PREFIX = 'DSH-FFI\t'
const MAX_BUFFERED = 256 * 1024

function schemeValue (value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error('E-FFI-TYPE'), { code: 'E-FFI-TYPE' })
    return String(value)
  }
  if (typeof value === 'boolean') return value ? '#t' : '#f'
  if (Array.isArray(value)) return `(list ${value.map(schemeValue).join(' ')})`
  if (value === null || value === undefined) return "'()"
  throw new Error('E-FFI-TYPE')
}

export class CvmClient {
  constructor({ guestFile, projectFiles = [], assetDir = DEFAULT_ASSET_DIR, ffi = null, ffiTimeoutMs = 1000, ffiTargets = null } = {}) {
    this.ffi = ffi
    this.ffiTargets = ffiTargets ? new Set(ffiTargets) : null
    this.ffiTimeoutMs = ffiTimeoutMs
    this.bridgeToken = ffi ? randomUUID() : null
    this.bridge = ffi
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
    this.termination = null
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
        const newline = this.buffered.indexOf(0x0a)
        if (newline < 0) break
        const line = this.buffered.subarray(0, newline).toString('utf8')
        this.buffered = this.buffered.subarray(newline + 1)
        if (!line.startsWith(FFI_FRAME_PREFIX)) continue
        this.bridgeChain = this.bridgeChain
          .then(() => this.handleFfiFrame(line.slice(FFI_FRAME_PREFIX.length)))
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

  async handleFfiFrame (text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
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
    if (this.currentRuleHash === null || frame.rule !== this.currentRuleHash) {
      this.kill(Object.assign(new Error('FFI frame rule mismatch'), { code: 'E-FFI-FRAME' }))
      return
    }
    if (!this.ffiTargets || !this.ffiTargets.has(frame.target)) {
      this.sendBridge(Buffer.from('(error "E-FFI-NOT-DECLARED")\n', 'utf8'))
      return
    }
    if (frame.kind !== 'ffi') {
      this.sendBridge(Buffer.from('(error "E-FFI-UNKNOWN")\n', 'utf8'))
      return
    }
    if (this.seenRequestIds.has(frame.rid)) {
      this.sendBridge(Buffer.from('(error "E-FFI-REQUEST-REUSED")\n', 'utf8'))
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
      const result = await Promise.race([
        Promise.resolve().then(() => this.ffi.call({
          requestId: frame.rid,
          ruleHash: this.currentRuleHash,
          module: frame.target.split('.')[0],
          function: frame.target.split('.').slice(1).join('.'),
          target: frame.target,
          args: frame.args,
          signal: controller.signal,
        })),
        timeout,
      ])
      if (this.dead) return
      this.sendBridge(Buffer.from(`(ok ${schemeValue(result)})\n`, 'utf8'))
    } catch (error) {
      if (error && error.code === 'E-TIMEOUT') {
        controller.abort()
        this.kill(Object.assign(new Error('FFI timeout'), { code: 'E-TIMEOUT' }))
        return
      }
      const code = error && error.code === 'E-FFI-TYPE' ? error.code : 'E-FFI-HOST'
      if (!this.dead) this.sendBridge(Buffer.from(`(error ${JSON.stringify(code)})\n`, 'utf8'))
    } finally {
      if (timer) clearTimeout(timer)
      this.activeControllers.delete(controller)
    }
  }

  kill (reason) {
    if (this.dead) return
    this.dead = true
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

  async dispatch(payload, timeoutMs) {
    await this.loaded
    const message = await this.request('dispatch', payload, timeoutMs)
    return message.text
  }

  async resume(payload, timeoutMs) {
    const message = await this.request('resume', payload, timeoutMs)
    return message.text
  }

  async close() {
    if (this.dead) {
      if (this.termination) await this.termination
      return
    }
    this.dead = true
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
