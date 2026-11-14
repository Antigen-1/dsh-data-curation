import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SchemeV2Runtime } from '../lib/rules/index.js'
import { evaluateHeartbeat } from '../lib/rules/scheme/v2/supervisor.js'
import { parseLinuxRss, createRssSampler } from '../lib/rules/scheme/v2/resource-sampler.js'

const pin = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-a.json', import.meta.url)), 'utf8'))
const programPin = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-program-a.json', import.meta.url)), 'utf8'))
const programRoot = fileURLToPath(new URL('./fixtures/scheme-v2/program-project', import.meta.url))

test('gcStats reports full-collect live bytes and advances gcCount', async (t) => {
  const runtime = await SchemeV2Runtime.open(pin, { debugGcStats: true })
  t.after(() => runtime.close().catch(() => {}))
  const first = await runtime.gcStats()
  assert.equal(first.fullCollect, true)
  assert.equal(first.maxGeneration, 4)
  assert.equal(first.radix, 4)
  for (const key of ['liveBytes', 'heapReservedBytes', 'allocatedTotal', 'reclaimedTotal', 'gcCount']) {
    assert.equal(Number.isSafeInteger(first[key]), true, key)
    assert.ok(first[key] >= 0, key)
  }
  assert.equal(await runtime.call('rule.example'), 42)
  const second = await runtime.gcStats()
  assert.ok(second.gcCount > first.gcCount)
  assert.ok(second.liveBytes > 0)
})

test('gcStats tracks a known live object across full collections', async (t) => {
  const runtime = await SchemeV2Runtime.open(programPin, { projectRoot: programRoot, debugGcStats: true })
  t.after(() => runtime.close().catch(() => {}))
  const before = await runtime.gcStats()
  assert.equal(await runtime.callRule('gc-hold', [1, 0, 0]), 1)
  const held = await runtime.gcStats()
  assert.ok(
    held.liveBytes - before.liveBytes > 4 * 1024 * 1024,
    `expected liveBytes to grow by at least 4 MiB, before=${before.liveBytes} held=${held.liveBytes}`,
  )
  assert.equal(await runtime.callRule('gc-drop', [1, 0, 0]), 1)
  const dropped = await runtime.gcStats()
  assert.ok(
    dropped.liveBytes - before.liveBytes < 2 * 1024 * 1024,
    `expected liveBytes to return near baseline, before=${before.liveBytes} dropped=${dropped.liveBytes}`,
  )
})

test('supervised runtime exposes debug-gated gcStats', async (t) => {
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    debugGcStats: true,
    resource: { rssSampleMs: 0 },
  })
  t.after(() => runtime.close().catch(() => {}))
  const stats = await runtime.gcStats()
  assert.equal(stats.fullCollect, true)
  assert.ok(stats.liveBytes > 0)
})

test('bare gcStats is distinguishable from full gcStats', async (t) => {
  const runtime = await SchemeV2Runtime.open(pin, { debugGcStats: true })
  t.after(() => runtime.close().catch(() => {}))
  const bare = await runtime.vm.gcStatsBare()
  const full = await runtime.gcStats()
  assert.equal(bare.fullCollect, false)
  assert.equal(full.fullCollect, true)
  assert.ok(full.gcCount >= bare.gcCount)
})

test('parseLinuxRss reads VmRSS in bytes', () => {
  assert.equal(parseLinuxRss('Name:\tnode\nVmRSS:\t  12345 kB\n'), 12345 * 1024)
  assert.throws(() => parseLinuxRss('Name:\tnode\n'), /VmRSS not found/)
})

test('supervised runtime emits a soft RSS warning without killing', async (t) => {
  const events = []
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    resource: { rssSampleMs: 20, rssSoftBytes: 1, rssHardBytes: 1_000_000, heartbeatIntervalMs: 50 },
    rssSampler: async () => 2,
    onEvent: (event) => events.push(event),
  })
  t.after(() => runtime.close())
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(await runtime.call('rule.example'), 42)
  assert.ok(events.some((event) => event.event === 'resource-warning'))
  const stats = runtime.vm.resourceStats()
  assert.equal(stats.rss, 2)
  assert.ok(stats.lastHeartbeatAt)
})

test('supervised runtime survives a transient parent event-loop stall', async (t) => {
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    resource: { rssSampleMs: 0, heartbeatIntervalMs: 50, heartbeatMisses: 3 },
  })
  t.after(() => runtime.close().catch(() => {}))
  assert.equal(await runtime.call('rule.example'), 42)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(runtime.vm.dead, false)
  assert.equal(await runtime.call('rule.example'), 42)
})

test('supervised runtime auto-restarts after a hard resource kill', async (t) => {
  let rss = 1
  const events = []
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    autoRestart: true,
    restartBackoffMs: [20],
    maxRestarts: 2,
    resource: { rssSampleMs: 20, rssSoftBytes: 1, rssHardBytes: 2, heartbeatIntervalMs: 50 },
    rssSampler: async () => rss,
    onEvent: (event) => {
      events.push(event)
      if (event.event === 'resource-kill' && event.reason === 'E-RESOURCE-RSS') rss = 1
    },
  })
  t.after(() => runtime.close().catch(() => {}))
  assert.equal(await runtime.call('rule.example'), 42)
  rss = 3
  for (let index = 0; index < 80 && runtime.restarts === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(runtime.restarts, 1)
  assert.equal(runtime.closed, false)
  assert.equal(await runtime.call('rule.example'), 42)
  assert.ok(events.some((event) => event.event === 'restart-scheduled'))
})

test('supervised runtime rejects unsafe resource limits', async () => {
  await assert.rejects(
    SchemeV2Runtime.open(pin, { supervised: true, resource: { heartbeatMisses: 0 } }),
    (error) => error.code === 'E-RESOURCE-CONFIG',
  )
  await assert.rejects(
    SchemeV2Runtime.open(pin, { supervised: true, resource: { rssSoftBytes: 10, rssHardBytes: 1 } }),
    (error) => error.code === 'E-RESOURCE-CONFIG',
  )
})

test('supervised runtime stops restarting after the restart limit', async (t) => {
  const events = []
  let rss = 1
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    autoRestart: true,
    restartBackoffMs: [20],
    maxRestarts: 1,
    resource: { rssSampleMs: 20, rssSoftBytes: 1, rssHardBytes: 2, heartbeatIntervalMs: 50 },
    rssSampler: async () => rss,
    onEvent: (event) => events.push(event),
  })
  t.after(() => runtime.close().catch(() => {}))
  assert.equal(await runtime.call('rule.example'), 42)
  rss = 3
  for (let index = 0; index < 120 && !events.some((event) => event.event === 'resource-restart-limit'); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(events.some((event) => event.event === 'resource-restart-limit'))
  assert.equal(runtime.vm.dead, true)
})

test('supervised runtime kills the child when RSS exceeds the hard limit', async (t) => {
  const events = []
  let rss = 1
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    autoRestart: false,
    resource: { rssSampleMs: 20, rssSoftBytes: 1, rssHardBytes: 2, heartbeatIntervalMs: 50 },
    rssSampler: async () => rss,
    onEvent: (event) => events.push(event),
  })
  t.after(() => runtime.close().catch(() => {}))
  assert.equal(await runtime.call('rule.example'), 42)
  rss = 3
  for (let index = 0; index < 50 && !runtime.vm.dead; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(runtime.vm.dead, true)
  assert.ok(events.some((event) => event.event === 'resource-kill' && event.reason === 'E-RESOURCE-RSS'))
  await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-VM-DEAD' || error.code === 'E-RESOURCE-RSS')
})

test('heartbeat misses kill only after the configured consecutive strikes', () => {
  const first = evaluateHeartbeat({
    lastAt: 1000,
    strikes: 0,
    intervalMs: 10,
    misses: 2,
    now: 2000,
  })
  assert.equal(first.kill, false)
  assert.equal(first.strikes, 1)
  const second = evaluateHeartbeat({
    lastAt: 1000,
    strikes: first.strikes,
    intervalMs: 10,
    misses: 2,
    now: 2000,
  })
  assert.equal(second.kill, true)
  assert.equal(second.strikes, 2)
  const active = evaluateHeartbeat({
    active: true,
    lastAt: 1000,
    strikes: 1,
    intervalMs: 10,
    misses: 2,
    now: 2000,
  })
  assert.equal(active.kill, false)
  assert.equal(active.strikes, 0)
})

test('Windows RSS sampler uses a bounded PowerShell call', async () => {
  const calls = []
  const sampler = createRssSampler({
    platform: 'win32',
    exec: (file, args, options, callback) => {
      calls.push({ file, args, options })
      callback(null, '12345\n', '')
    },
  })
  assert.equal(await sampler(42), 12345)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'powershell.exe')
  assert.equal(calls[0].args.at(-1), '(Get-Process -Id 42).WorkingSet64')
  assert.equal(calls[0].options.timeout, 2000)
  assert.equal(calls[0].options.killSignal, 'SIGKILL')
})

test('supervised runtime kills the child when Wasm memory exceeds the hard limit', async (t) => {
  const events = []
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    autoRestart: false,
    resource: {
      rssSampleMs: 0,
      heartbeatIntervalMs: 20,
    },
    onEvent: (event) => events.push(event),
  })
  t.after(() => runtime.close().catch(() => {}))
  runtime.vm.resource.wasmSoftBytes = 1
  runtime.vm.resource.wasmHardBytes = 1
  for (let index = 0; index < 100 && !runtime.vm.dead; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(runtime.vm.dead, true)
  assert.ok(events.some((event) => event.event === 'resource-kill' && event.reason === 'E-RESOURCE-WASM'))
})
