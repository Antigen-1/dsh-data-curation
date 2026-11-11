import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { SchemeV2Runtime } from '../lib/rules/index.js'

const pinPath = fileURLToPath(new URL('../test/fixtures/scheme-v2/pin-v2-a.json', import.meta.url))
const iterations = Number(process.argv[2] || 3000)
const sampleEvery = Number(process.argv[3] || 100)
const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
const runtime = await SchemeV2Runtime.open(pin)

function percentile (sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function summarize (samples) {
  samples.sort((a, b) => a - b)
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    p99Ms: Number(percentile(samples, 0.99).toFixed(3)),
  }
}

const baseline = []
const measured = []
let sampled = 0
try {
  for (let index = 0; index < iterations; index += 1) {
    const readMetrics = sampleEvery <= 1 || index % sampleEvery === 0
    const order = index % 2 === 0
      ? ['baseline', 'measured']
      : ['measured', 'baseline']
    for (const kind of order) {
      const start = performance.now()
      await runtime.call('rule.example')
      if (kind === 'measured' && readMetrics) {
        runtime.metrics()
        sampled += 1
      }
      const elapsed = performance.now() - start
      if (kind === 'baseline') baseline.push(elapsed)
      else measured.push(elapsed)
    }
  }
  const base = summarize(baseline)
  const withMetrics = summarize(measured)
  const metrics = runtime.metrics()
  console.log(JSON.stringify({
    iterations,
    sampleEvery,
    sampled,
    baseline: base,
    withMetrics,
    p95Overhead: Number(((withMetrics.p95Ms - base.p95Ms) / base.p95Ms).toFixed(4)),
    rss: metrics.rss,
    wasmBytes: metrics.wasmBytes,
  }, null, 2))
} finally {
  await runtime.close()
}
