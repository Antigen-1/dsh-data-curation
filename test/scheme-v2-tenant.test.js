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
const ffiMathUrl = new URL('./fixtures/scheme-v2/ffi/math.mjs', import.meta.url).href

function projectRoot () {
  return mkdtempSync(join(tmpdir(), 'dsh-tenant-'))
}

test('TenantManager runs isolated workers and serializes commands', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({
    projectRoot: root,
    maxQueue: 0,
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

test('TenantManager rejects the queue when a tenant VM dies', async (t) => {
  const root = projectRoot()
  const manager = await TenantManager.open({ projectRoot: root, tenants: [{ id: 'dead', pin }] })
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
