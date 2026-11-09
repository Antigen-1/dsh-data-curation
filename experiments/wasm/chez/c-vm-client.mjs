import { Worker } from 'node:worker_threads'

export class CvmClient {
  constructor({ guestFile, projectFiles = [], assetDir } = {}) {
    this.worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url), {
      workerData: { guestFile, projectFiles, assetDir },
    })
    this.nextId = 0
    this.pending = new Map()
    this.dead = false
    this.closeReason = null
    this.loaded = new Promise((resolve, reject) => {
      this.loadedResolve = resolve
      this.loadedReject = reject
    })
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

  kill (reason) {
    if (this.dead) return
    this.dead = true
    this.closeReason = reason && reason.code ? reason.code : 'E-VM-CLOSED'
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (!error.code) error.code = 'E-VM-CLOSED'
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    void this.worker.terminate()
  }

  onMessage(message) {
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
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`${type} timeout`)
        error.code = 'E-TIMEOUT'
        this.kill(error)
        reject(error)
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
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
    this.dead = true
    this.closeReason = 'E-VM-CLOSED'
    for (const waiter of this.pending.values()) {
      const error = new Error('incarnation is closed')
      error.code = 'E-VM-CLOSED'
      waiter.reject(error)
    }
    this.pending.clear()
    await this.worker.terminate()
  }
}
