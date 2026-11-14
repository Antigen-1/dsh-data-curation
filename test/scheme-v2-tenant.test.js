import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TenantManager } from '../lib/rules/index.js'

const pin = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-a.json', import.meta.url)), 'utf8'))
const ffiPin = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-ffi-a.json', import.meta.url)), 'utf8'))
const pluginPin = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-plugin-a.json', import.meta.url)), 'utf8'))
const programPin = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-program-a.json', import.meta.url)), 'utf8'))
const ffiMathUrl = new URL('./fixtures/scheme-v2/ffi/math.mjs', import.meta.url).href

function projectRoot () {
  return mkdtempSync(join(tmpdir(), 'dsh-tenant-'))
}

test('TenantManager runs isolated workers and serializes commands', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({
    projectRoot: root,
    maxQueue: 0,
    debugGcStats: true,
    tenants: [
      { id: 'alpha', pin },
      { id: 'beta', pin },
    ],
  })
  t.after(() => manager.close())

  assert.deepEqual(manager.list().map((tenant) => tenant.id).sort(), ['alpha', 'beta'])
  assert.ok(existsSync(join(root, 'tenants', 'alpha')))
  assert.ok(existsSync(join(root, 'tenants', 'beta')))

  assert.equal(await manager.call('alpha', 'rule.example'), 42)
  assert.equal(await manager.call('beta', 'rule.example'), 42)
  assert.equal((await manager.metrics('alpha')).calls >= 1, true)
  assert.equal((await manager.metrics('beta')).calls >= 1, true)
  const gcStats = await manager.gcStats('alpha')
  assert.equal(gcStats.isolation, 'process')
  assert.equal(gcStats.fullCollect, true)
  assert.ok(Number.isSafeInteger(gcStats.liveBytes) && gcStats.liveBytes > 0)
  assert.ok(Number.isSafeInteger(gcStats.pid) && gcStats.pid > 0)

  const first = manager.call('alpha', 'rule.example')
  await assert.rejects(manager.call('alpha', 'rule.example'), (error) => error.code === 'E-TENANT-BUSY')
  assert.equal(await first, 42)

  await manager.closeTenant('alpha')
  assert.equal(manager.get('alpha'), null)
  assert.equal(await manager.call('beta', 'rule.example'), 42)

  await manager.restart('beta')
  assert.equal(await manager.call('beta', 'rule.example'), 42)

  await manager.terminate('beta')
  await assert.rejects(manager.call('beta', 'rule.example'), (error) => error.code === 'E-TENANT-CRASH' || error.code === 'E-TENANT-CLOSED')
  await manager.restart('beta')
  assert.equal(await manager.call('beta', 'rule.example'), 42)
})

test('TenantManager exposes debug-gated gcStats in worker isolation', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({
    projectRoot: root,
    debugGcStats: true,
    tenants: [{ id: 'worker-gc', pin, isolation: 'worker' }],
  })
  t.after(() => manager.close())
  const stats = await manager.gcStats('worker-gc')
  assert.equal(stats.isolation, 'worker')
  assert.equal(stats.fullCollect, true)
  assert.ok(Number.isSafeInteger(stats.liveBytes) && stats.liveBytes > 0)
})

test('TenantManager runs FFI in the tenant worker and keeps other tenants independent', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({
    projectRoot: root,
    tenants: [
      { id: 'ffi-a', pin: ffiPin, ffiModules: { math: ffiMathUrl } },
      { id: 'plain', pin },
    ],
  })
  t.after(() => manager.close())

  assert.equal(await manager.call('ffi-a', 'rule.example'), 42)
  assert.equal(await manager.call('plain', 'rule.example'), 42)
  assert.equal((await manager.metrics('ffi-a')).errors, 0)
  assert.equal((await manager.metrics('plain')).errors, 0)
})

test('TenantManager rejects invalid tenant identifiers and duplicate ids', async () => {
  const root = projectRoot()
  await assert.rejects(
    TenantManager.open({ projectRoot: root, tenants: [{ id: '../escape', pin }] }),
    (error) => error.code === 'E-TENANT-CONFIG',
  )
  await assert.rejects(
    TenantManager.open({ projectRoot: root, tenants: [{ id: 'same', pin }, { id: 'same', pin }] }),
    (error) => error.code === 'E-TENANT-CONFIG',
  )
  await assert.rejects(
    TenantManager.open({ projectRoot: root, tenants: [{ id: 'Alpha', pin }, { id: 'alpha', pin }] }),
    (error) => error.code === 'E-TENANT-CONFIG',
  )
  await assert.rejects(
    TenantManager.open({ projectRoot: root, maxQueue: 'many', tenants: [{ id: 'valid', pin }] }),
    (error) => error.code === 'E-TENANT-CONFIG',
  )
})

test('TenantManager rejects calls during restart and exposes gc', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({ projectRoot: root, tenants: [{ id: 'lifecycle', pin }] })
  t.after(() => manager.close())

  const restarting = manager.restart('lifecycle')
  await assert.rejects(
    manager.call('lifecycle', 'rule.example'),
    (error) => error.code === 'E-TENANT-RESTART',
  )
  await restarting
  assert.equal(await manager.call('lifecycle', 'rule.example'), 42)
  await manager.gc('lifecycle', 1000)
  await assert.rejects(
    manager.callRule('lifecycle', 'rule.example', [9, 9, 9]),
    (error) => error.code === 'E-RULE-NOT-LOADED',
  )
})

test('TenantManager defaults to an OS process per tenant', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({ projectRoot: root, tenants: [{ id: 'process', pin }] })
  t.after(() => manager.close())
  const runtime = manager.get('process')
  assert.equal(runtime.constructor.name, 'ProcessTenantRuntime')
  assert.ok(Number.isInteger(runtime.pid))
  assert.equal(await manager.call('process', 'rule.example'), 42)
  const metrics = await manager.metrics('process')
  assert.equal(metrics.isolation, 'process')
  assert.equal(metrics.pid, runtime.pid)
})

test('TenantManager rejects the queue when a tenant VM dies', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({ projectRoot: root, tenants: [{ id: 'dead', pin, isolation: 'worker' }] })
  t.after(() => manager.close())

  const runtime = manager.get('dead')
  let activeError
  let queuedError
  runtime.active = { id: 1, timer: null, resolve () {}, reject (error) { activeError = error } }
  runtime.queue.push({ id: 2, timer: null, resolve () {}, reject (error) { queuedError = error } })
  runtime._onMessage({
    type: 'result',
    id: 1,
    ok: false,
    error: { code: 'E-VM-DEAD', message: 'vm died' },
  })

  assert.equal(activeError.code, 'E-VM-DEAD')
  assert.equal(queuedError.code, 'E-TENANT-CRASH')
  assert.equal(runtime.status, 'crashed')
  await assert.rejects(manager.call('dead', 'rule.example'), (error) => error.code === 'E-TENANT-CRASH')
})

test('TenantManager opens a plugin pin when the tenant root has project rules', async (t) => {
  const root = projectRoot()
  const tenantRoot = join(root, 'tenants', 'plugins')
  cpSync(
    fileURLToPath(new URL('./fixtures/scheme-v2/project/rules', import.meta.url)),
    join(tenantRoot, 'rules'),
    { recursive: true },
  )
  const manager = await TenantManager.open({
    projectRoot: root,
    tenants: [{ id: 'plugins', pin: pluginPin }],
  })
  t.after(() => manager.close())
  assert.equal(await manager.call('plugins', 'rule.example'), 42)
})

test('TenantManager returns synchronous program results and terminate does not resurrect', async (t) => {
  const root = projectRoot()
  const tenantRoot = join(root, 'tenants', 'programs')
  cpSync(
    fileURLToPath(new URL('./fixtures/scheme-v2/program-project/rules', import.meta.url)),
    join(tenantRoot, 'rules'),
    { recursive: true },
  )
  const manager = await TenantManager.open({
    projectRoot: root,
    tenants: [{ id: 'programs', pin: programPin }],
  })
  t.after(() => manager.close())

  assert.deepEqual(await manager.programResult('programs', 'bootstrap', [1]), ['strict', 42])

  const runtime = manager.get('programs')
  const supervisor = runtime.runtime.vm
  await manager.terminate('programs')
  assert.equal(runtime.status, 'crashed')
  const restarts = runtime.runtime?.restartTimes?.length ?? 0
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(runtime.status, 'crashed')
  assert.equal(supervisor.dead, true)
  assert.equal(runtime.runtime?.restartTimes?.length ?? 0, restarts)
})

test('TenantManager rejects a tenant that cannot open in time', async () => {
  await assert.rejects(
    TenantManager.open({
      projectRoot: projectRoot(),
      tenants: [{ id: 'slow', pin, openTimeoutMs: 0 }],
    }),
    (error) => error.code === 'E-TENANT-OPEN-TIMEOUT',
  )
})
