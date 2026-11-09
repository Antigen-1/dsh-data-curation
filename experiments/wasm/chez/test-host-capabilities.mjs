import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CvmClient } from './c-vm-client.mjs'
import { createHostCapabilities, CapabilityError } from './host-capabilities.mjs'
import { createFfiRegistry, FfiError, validateFfiManifest } from './ffi-registry.mjs'
import { FfiBroker } from './ffi-broker.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1-c', 'capabilities.json')
const PROJECT = [{ path: '/project/lib/mem.scm', content: '(library (dsh lib mem v1) (export answer) (import (rnrs base (6))) (define (answer) 42))' }]

function schemeString(value) {
  return JSON.stringify(String(value))
}

function schemeValue(value) {
  if (typeof value === 'string') return schemeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return schemeString(String(value))
}

function ffiRequest(id, rid, kind, rule, target, args) {
  return `(request ${schemeString(id)} ffi-call ${schemeString(rid)} ${schemeString(kind)} ${schemeString(rule)} ${schemeString(target)} (${args.map(schemeValue).join(' ')}))`
}

async function send(client, id, rid, kind, rule, target, args) {
  const text = await client.dispatch(ffiRequest(id, rid, kind, rule, target, args))
  return JSON.parse(text)
}

async function resume(client, rid, ok, value) {
  return JSON.parse(await client.resume(`(resume ${schemeString(rid)} ${ok ? '#t' : '#f'} ${schemeValue(value)})`))
}

const manifest = validateFfiManifest(JSON.parse(readFileSync(join(HERE, 'ffi-manifest.json'), 'utf8')))
const manifestChecks = {}
try {
  validateFfiManifest({
    version: 1,
    modules: { math: { functions: { add: { arity: 1, mode: 'sync', path: '/etc/passwd' } } } },
  })
  manifestChecks.pathRejected = false
} catch (error) {
  manifestChecks.pathRejected = error.code === 'E-FFI-MANIFEST'
}
try {
  createFfiRegistry({ manifest, handlers: {} })
  manifestChecks.missingHandlerRejected = false
} catch (error) {
  manifestChecks.missingHandlerRejected = error.code === 'E-FFI-MISSING'
}
const ffi = createFfiRegistry({
  manifest,
  handlers: {
    'math.add': ([a, b]) => a + b,
    'math.fail': () => { throw new FfiError('E-FFI-HOST', 'host rejected') },
    'delay.echo': ([value]) => new Promise((resolve) => setTimeout(() => resolve(value), 30)),
    'delay.slow': () => new Promise((resolve) => setTimeout(() => resolve('too-late'), 300)),
  },
})
const capabilities = createHostCapabilities({ projectFiles: PROJECT })
const client = new CvmClient({ projectFiles: PROJECT })
await client.loaded
const broker = new FfiBroker({
  capabilities,
  ffi,
  timeoutMs: 100,
  resume: async (rid, ok, value) => {
    const response = await resume(client, rid, ok, value)
    return response
  },
})

const checks = {}
const results = []

async function run(name, fn) {
  try {
    const value = await fn()
    checks[name] = value
    results.push({ name, value })
  } catch (error) {
    checks[name] = { error: error.code || error.message }
    results.push({ name, error: error.code || error.message })
  }
}

await run('project-read', async () => {
  const suspended = await send(client, 'c1', 'r1', 'capability', 'rule-a', 'project.read', ['/project/lib/mem.scm'])
  if (suspended.status !== 'suspended') throw new Error(JSON.stringify(suspended))
  const out = await broker.dispatch(suspended)
  return { value: out.value, response: out.response.value }
})

await run('log-write', async () => {
  const suspended = await send(client, 'c2', 'r2', 'capability', 'rule-a', 'log.write', ['hello'])
  const out = await broker.dispatch(suspended)
  return { value: out.value, audit: capabilities.audit().at(-1) }
})

await run('clock-now', async () => {
  const suspended = await send(client, 'c3', 'r3', 'capability', 'rule-a', 'clock.now', [])
  const out = await broker.dispatch(suspended)
  return { value: out.value, nondeterministic: capabilities.audit().at(-1).nondeterministic }
})

await run('sync-ffi', async () => {
  const suspended = await send(client, 'f1', 'r4', 'ffi', 'rule-a', 'math.add', [1, 2])
  const out = await broker.dispatch(suspended)
  return out.value
})

await run('async-ffi', async () => {
  const suspended = await send(client, 'f2', 'r5', 'ffi', 'rule-a', 'delay.echo', ['hello'])
  const out = await broker.dispatch(suspended)
  return out.value
})

await run('ffi-error', async () => {
  const suspended = await send(client, 'f3', 'r6', 'ffi', 'rule-a', 'math.fail', [])
  const out = await broker.dispatch(suspended)
  return { ok: out.ok, error: out.error, response: out.response }
})

await run('reentrant', async () => {
  const first = await send(client, 'f4', 'r7', 'ffi', 'rule-a', 'delay.echo', ['one'])
  const second = await send(client, 'f5', 'r8', 'ffi', 'rule-a', 'delay.echo', ['two'])
  await resume(client, 'r7', true, 'one')
  return { first: first.status, second: second.error?.code }
})

await run('late-response', async () => {
  const suspended = await send(client, 'f6', 'r9', 'ffi', 'rule-a', 'math.add', [2, 3])
  const late = await resume(client, 'wrong', true, 5)
  const correct = await resume(client, 'r9', true, 5)
  return { late: late.error?.code, correct: correct.value }
})

await run('timeout-late-drop', async () => {
  const suspended = await send(client, 'f7', 'r10', 'ffi', 'rule-a', 'delay.slow', [])
  const out = await broker.dispatch(suspended)
  const after = await resume(client, 'r10', true, 'late')
  if (out.error !== 'E-TIMEOUT') throw new Error(`expected E-TIMEOUT, got ${out.error}`)
  return { broker: out.error, after: after.error?.code }
})

await run('cancel', async () => {
  const suspended = await send(client, 'f8', 'r12', 'ffi', 'rule-a', 'delay.echo', ['cancel-me'])
  const response = await resume(client, 'r12', false, 'E-CANCELLED')
  return response.error?.code
})

await run('capability-denied', async () => {
  const suspended = await send(client, 'c4', 'r11', 'capability', 'rule-a', 'project.read', ['/project/secret.txt'])
  const out = await broker.dispatch(suspended)
  return { status: out.error, response: out.response }
})

await run('two-concurrent-vms', async () => {
  const other = new CvmClient({ projectFiles: PROJECT })
  await other.loaded
  const a = await send(client, 'g1', 's1', 'ffi', 'rule-a', 'math.add', [10, 1])
  const b = await send(other, 'g2', 's2', 'ffi', 'rule-a', 'math.add', [20, 2])
  const [ra, rb] = await Promise.all([broker.dispatch(a), (async () => {
    const r = await resume(other, 's2', true, 22)
    await other.close()
    return { value: r.value }
  })()])
  return { a: ra.value, b: rb.value }
})

const ok = results.every((entry) => !entry.error) && manifestChecks.pathRejected && manifestChecks.missingHandlerRejected
mkdirSync(dirname(RESULT), { recursive: true })
const payload = {
  ok,
  checkedAt: new Date().toISOString(),
  manifest,
  manifestChecks,
  checks,
  results,
  capabilityAudit: capabilities.audit(),
  brokerAudit: broker.audit,
}
writeFileSync(RESULT, `${JSON.stringify(payload, null, 2)}\n`)
writeFileSync(join(dirname(RESULT), 'ffi.json'), `${JSON.stringify({
  checkedAt: payload.checkedAt,
  manifest,
  sync: checks['sync-ffi'],
  async: checks['async-ffi'],
  error: checks['ffi-error'],
}, null, 2)}\n`)
writeFileSync(join(dirname(RESULT), 'async-faults.json'), `${JSON.stringify({
  checkedAt: payload.checkedAt,
  reentrant: checks.reentrant,
  lateResponse: checks['late-response'],
  timeoutLateDrop: checks['timeout-late-drop'],
  cancel: checks.cancel,
  concurrent: checks['two-concurrent-vms'],
}, null, 2)}\n`)
console.log(JSON.stringify({ ok, checks, out: RESULT }, null, 2))
await client.close()
if (!ok) process.exit(1)
