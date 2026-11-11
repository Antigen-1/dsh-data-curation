import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SchemeV2Runtime } from '../lib/rules/index.js'

const pinPath = fileURLToPath(new URL('../test/fixtures/scheme-v2/pin-v2-a.json', import.meta.url))
const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
const iterations = Number(process.argv[2] || 200)
const runtime = await SchemeV2Runtime.open(pin)
const samples = []
const startedAll = performance.now()
try {
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    await runtime.call('rule.example')
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]
  const totalMs = performance.now() - startedAll
  const memory = runtime.metrics()
  const report = {
    iterations,
    totalMs: Number(totalMs.toFixed(3)),
    callsPerSecond: Number((iterations / (totalMs / 1000)).toFixed(3)),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    p99Ms: Number(percentile(0.99).toFixed(3)),
    rss: memory.rss,
    wasmBytes: memory.wasmBytes,
    calls: memory.calls,
    errors: memory.errors,
  }
  const afterGc = await runtime.gc(5000)
  report.rssAfterGc = afterGc.rss
  report.wasmBytesAfterGc = afterGc.wasmBytes
  console.log(JSON.stringify(report, null, 2))
} finally {
  await runtime.close()
}
