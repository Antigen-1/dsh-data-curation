import { appendFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { SchemeV2Runtime } from '../lib/rules/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(`${root}/test/fixtures/scheme-v2/${name}`, 'utf8'))
const durationMs = Number(process.env.DSH_MIXED_MS || 600000)
const outPath = process.env.DSH_MIXED_OUT || `${root}/experiments/scheme-v2-mixed-smoke.jsonl`
const ffiMath = new URL('../test/fixtures/scheme-v2/ffi/math.mjs', import.meta.url)
const pluginRoot = `${root}/test/fixtures/scheme-v2/project`
const programRoot = `${root}/test/fixtures/scheme-v2/program-project`
const supervised = process.env.DSH_MIXED_SUPERVISED === '1'
const baseOptions = supervised
  ? { supervised: true, resource: { rssSampleMs: Number(process.env.DSH_MIXED_RSS_MS || 30000) } }
  : {}
const events = []
const runtimeOptions = (name, extra = {}) => ({
  ...baseOptions,
  ...extra,
  onEvent: (event) => {
    if (event.event !== 'heartbeat' && events.length < 50) events.push({ runtime: name, ...event })
  },
})

const runtimes = {
  static: await SchemeV2Runtime.open(fixture('pin-v2-a.json'), runtimeOptions('static')),
  plugin: await SchemeV2Runtime.open(fixture('pin-v2-plugin-a.json'), runtimeOptions('plugin', { projectRoot: pluginRoot })),
  program: await SchemeV2Runtime.open(fixture('pin-v2-program-a.json'), runtimeOptions('program', { projectRoot: programRoot })),
  ffi: await SchemeV2Runtime.open(fixture('pin-v2-ffi-a.json'), runtimeOptions('ffi', { ffiModules: { math: ffiMath } })),
}

writeFileSync(outPath, '')
const started = performance.now()
let calls = 0
let staticCalls = 0
let pluginCalls = 0
let programCalls = 0
let ffiCalls = 0
let errors = 0
const errorsByCode = {}
const samples = []
let nextSample = started + 30000
let windowLatencies = []
let finalMetrics = null
const percentile = (values, p) => values.length === 0 ? null : values[Math.min(values.length - 1, Math.floor(values.length * p))]

try {
  while (performance.now() - started < durationMs) {
    const bucket = Math.floor(calls % 10)
    const callStarted = performance.now()
    try {
      if (bucket < 7) {
        staticCalls += 1
        await runtimes.static.call('rule.example')
      } else if (bucket < 9) {
        pluginCalls += 1
        await runtimes.plugin.call('rule.example')
      } else {
        programCalls += 1
        await runtimes.program.callRule('total', [1, 0, 0], [21])
      }
      if (bucket === 6) {
        ffiCalls += 1
        await runtimes.ffi.call('rule.example')
      }
    } catch (error) {
      errors += 1
      const code = error.code || 'E-ERROR'
      errorsByCode[code] = (errorsByCode[code] || 0) + 1
    }
    calls += 1
    windowLatencies.push(performance.now() - callStarted)
    if (performance.now() >= nextSample) {
      const byRuntime = {}
      for (const [name, runtime] of Object.entries(runtimes)) {
        const metrics = runtime.metrics()
        byRuntime[name] = {
          rss: metrics.resource?.rss ?? metrics.rss,
          wasmBytes: metrics.wasmBytes ?? null,
          pid: metrics.pid ?? null,
          restarts: metrics.restarts ?? 0,
          heartbeatAgeMs: metrics.resource?.lastHeartbeatAt
            ? Date.now() - metrics.resource.lastHeartbeatAt
            : null,
        }
      }
      const rssValues = Object.values(byRuntime).map((entry) => entry.rss).filter(Number.isFinite)
      const sorted = [...windowLatencies].sort((a, b) => a - b)
      const sample = {
        t: Math.round(performance.now() - started),
        calls,
        staticCalls,
        pluginCalls,
        programCalls,
        ffiCalls,
        errors,
        errorsByCode: { ...errorsByCode },
        events: [...events],
        latencySamples: sorted.length,
        p50Ms: Number((percentile(sorted, 0.5) ?? 0).toFixed(3)),
        p95Ms: Number((percentile(sorted, 0.95) ?? 0).toFixed(3)),
        p99Ms: Number((percentile(sorted, 0.99) ?? 0).toFixed(3)),
        lastMs: Number((performance.now() - callStarted).toFixed(3)),
        rss: rssValues.length > 0 ? Math.max(...rssValues) : null,
        rssByRuntime: byRuntime,
        wasmBytes: Math.max(...Object.values(byRuntime).map((entry) => entry.wasmBytes ?? 0)),
        restarts: Object.values(byRuntime).reduce((sum, entry) => sum + (entry.restarts ?? 0), 0),
        heartbeatAgeMs: Math.max(
          ...Object.values(byRuntime).map((entry) => entry.heartbeatAgeMs ?? 0),
        ),
      }
      windowLatencies = []
      samples.push(sample)
      appendFileSync(outPath, `${JSON.stringify(sample)}\n`)
      nextSample += 30000
    }
  }
} finally {
  try { await runtimes.static.gc(5000) } catch {}
  finalMetrics = runtimes.static.metrics()
  for (const runtime of Object.values(runtimes)) await runtime.close()
}

const summary = {
  durationMs: Math.round(performance.now() - started),
  supervised,
  calls,
  staticCalls,
  pluginCalls,
  programCalls,
  ffiCalls,
  errors,
  errorsByCode,
  events,
  samples: samples.filter((sample) => sample.latencySamples !== undefined).length,
  finalMetrics,
}
console.log(JSON.stringify(summary, null, 2))
