import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CvmClient } from './c-vm-client.mjs'
import { FfiBroker } from './ffi-broker.mjs'
import { createFfiRegistry } from './ffi-registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')

const vm = new CvmClient()
let timeoutCode = null
let afterDeathCode = null
try {
  try {
    await vm.dispatch('(request "hang" hang)', 100)
  } catch (error) {
    timeoutCode = error.code
  }
  try {
    await vm.dispatch('(request "get" get)', 100)
  } catch (error) {
    afterDeathCode = error.code
  }
} finally {
  await vm.close()
}

const manifest = {
  version: 1,
  modules: {
    slow: {
      functions: {
        echo: { arity: 1, args: ['string'], returns: 'string', mode: 'async' },
        reject: { arity: 1, args: ['string'], returns: 'string', mode: 'async' },
      },
    },
  },
}
let aborted = 0
const broker = new FfiBroker({
  capabilities: { call: () => 1 },
  ffi: createFfiRegistry({
    manifest,
    handlers: {
      'slow.echo': async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 80))
        return args[0]
      },
      'slow.reject': async () => { throw new Error('boom') },
    },
  }),
  resume: async () => { throw new Error('resume must not run after timeout') },
  abort: async () => { aborted += 1; return { terminated: false } },
  timeoutMs: 20,
})
const timed = await broker.dispatch({
  requestId: 'ffi-timeout',
  ruleHash: 'rule',
  kind: 'ffi',
  target: 'slow.echo',
  args: ['late'],
})
await new Promise((resolve) => setTimeout(resolve, 120))
const late = broker.audit.find((entry) => entry.requestId === 'ffi-timeout')

let reusedCode = null
try {
  await broker.dispatch({
    requestId: 'ffi-timeout',
    ruleHash: 'rule',
    kind: 'ffi',
    target: 'slow.echo',
    args: ['reused'],
  })
} catch (error) {
  reusedCode = error.code
}

let rejectionCode = null
try {
  await broker.invoke({ kind: 'ffi', target: 'slow.reject', args: ['x'] })
} catch (error) {
  rejectionCode = error.code
}

let cancelAborted = 0
const cancelBroker = new FfiBroker({
  capabilities: { call: () => 1 },
  ffi: createFfiRegistry({
    manifest,
    handlers: {
      'slow.echo': async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 80))
        return args[0]
      },
      'slow.reject': async () => { throw new Error('boom') },
    },
  }),
  resume: async () => {},
  abort: async () => { cancelAborted += 1; return { terminated: false } },
  timeoutMs: 200,
})
const pending = cancelBroker.dispatch({
  requestId: 'ffi-cancel',
  ruleHash: 'rule',
  kind: 'ffi',
  target: 'slow.echo',
  args: ['cancel-me'],
})
await new Promise((resolve) => setTimeout(resolve, 5))
const cancel = await cancelBroker.cancel('ffi-cancel')
const cancelled = await pending
const cancelEntry = cancelBroker.audit.find((entry) => entry.requestId === 'ffi-cancel')

const result = {
  ok: timeoutCode === 'E-TIMEOUT' && afterDeathCode === 'E-VM-DEAD' &&
      timed.ok === false && timed.abortRequested === true &&
      timed.terminated === false && aborted === 1 &&
      late && late.status === 'timeout' && late.late === true &&
      reusedCode === 'E-FFI-REQUEST-REUSED' &&
      rejectionCode === 'E-FFI-HOST' &&
      cancel.requested === true && cancelled.error === 'E-CANCELLED' &&
      cancelled.terminated === false && cancelAborted === 1 &&
      cancelEntry.status === 'cancelled',
  checkedAt: new Date().toISOString(),
  vm: { timeoutCode, afterDeathCode },
  broker: { timed, aborted, audit: late, reusedCode, rejectionCode },
  cancel: { requested: cancel.requested, error: cancelled.error, aborted: cancelAborted, status: cancelEntry.status },
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'incarnation-timeout.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
