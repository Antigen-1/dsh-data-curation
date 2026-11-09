// Experimental host wrapper: a failed Chez library evaluation poisons the VM
// because Chez's global library namespace cannot be rolled back. The only safe
// recovery is to discard the incarnation and replay the bundles that were
// already committed.
import { CvmClient } from './c-vm-client.mjs'

export function schemeString (value) {
  return '"' + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"'
}

function schemeList (items) {
  return '(' + items.map(schemeString).join(' ') + ')'
}

function schemeName (name) {
  return '(' + name.join(' ') + ')'
}

export class PluginRuntime {
  constructor ({ createVm }) {
    if (typeof createVm !== 'function') throw new TypeError('createVm is required')
    this.createVm = createVm
    this.vm = null
    this.committed = []
    this.nextId = 0
  }

  async start () {
    this.vm = this.createVm()
    await this.vm.loaded
    for (const sources of this.committed) {
      const result = await this.dispatch('plugin-load', schemeList(sources))
      if (!result.ok) {
        throw Object.assign(new Error(`replay failed: ${result.code || 'E-PLUGIN-REPLAY'}`), {
          code: 'E-PLUGIN-REPLAY',
        })
      }
    }
  }

  async dispatch (op, payload, timeoutMs = 5000) {
    if (!this.vm) await this.start()
    const id = `plugin-${++this.nextId}`
    const text = await this.vm.dispatch(`(request ${schemeString(id)} ${op} ${payload})`, timeoutMs)
    return this.parse(id, text)
  }

  parse (id, text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      throw Object.assign(new Error(`invalid guest response: ${text.slice(0, 200)}`), {
        code: 'E-PLUGIN-RESPONSE',
      })
    }
    if (message.ok === false) {
      const code = message.error && message.error.code ? message.error.code : 'E-PLUGIN'
      throw Object.assign(new Error(`${id}: ${code}`), { code })
    }
    return message
  }

  async load (sources, timeoutMs = 5000) {
    try {
      const result = await this.dispatch('plugin-load', schemeList(sources), timeoutMs)
      this.committed.push([...sources])
      return result.value
    } catch (error) {
      // A failed library evaluation can leak into Chez's process-global
      // namespace. Never return a live, poisoned incarnation to the caller.
      await this.restart()
      throw error
    }
  }

  async loadOrRestart (sources, timeoutMs = 5000) {
    return this.load(sources, timeoutMs)
  }

  async restart () {
    const old = this.vm
    this.vm = null
    if (old) await old.close()
    await this.start()
  }

  async pinBundle (timeoutMs = 5000) {
    const result = await this.dispatch('plugin-pin-bundle', '()', timeoutMs)
    return result.value
  }

  async count (timeoutMs = 5000) {
    const result = await this.dispatch('plugin-registry-count', '()', timeoutMs)
    return Number(result.value)
  }

  async present (name, timeoutMs = 5000) {
    const result = await this.dispatch('plugin-present', schemeName(name), timeoutMs)
    return result.value === true
  }

  async close () {
    const old = this.vm
    this.vm = null
    if (old) await old.close()
  }
}

export function createPluginRuntime (options = {}) {
  return new PluginRuntime({
    createVm: () => new CvmClient(options),
  })
}
