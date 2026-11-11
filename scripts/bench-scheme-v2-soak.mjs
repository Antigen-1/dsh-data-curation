import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { SchemeV2Runtime } from '../lib/rules/index.js'

const pinPath = fileURLToPath(new URL('../test/fixtures/scheme-v2/pin-v2-a.json', import.meta.url))
const outPath = process.env.DSH_SOAK_OUT
  ? resolve(process.cwd(), process.env.DSH_SOAK_OUT)
  : fileURLToPath(new URL('../experiments/scheme-v2-soak.jsonl', import.meta.url))
const durationMs = Number(process.argv[2] || 3600000)
const sampleMs = Number(process.argv[3] || 60000)
const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
const runtime = await SchemeV2Runtime.open(pin)
const started = performance.now()
let lastSample = started
let calls = 0
let errors = 0
const latencies = []
let latencyIndex = 0

function recordLatency (value) {
  if (latencies.length < 10000) {
    latencies.push(value)
  } else {
    latencies[latencyIndex] = value
    latencyIndex = (latencyIndex + 1) % 10000
  }
}

function percentile (sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

try {
  while (performance.now() - started < durationMs) {
    const batchStart = performance.now()
    while (performance.now() - batchStart < 1000) {
      const callStart = performance.now()
      try {
        await runtime.call('rule.example')
        calls += 1
        recordLatency(performance.now() - callStart)
      } catch {
        errors += 1
      }
    }
    const now = performance.now()
    if (now - lastSample >= sampleMs) {
      const beforeGc = runtime.metrics()
      await runtime.gc(5000)
      const sorted = [...latencies].sort((a, b) => a - b)
      const line = {
        elapsedSeconds: Number(((now - started) / 1000).toFixed(1)),
        calls,
        errors,
        rss: beforeGc.rss,
        wasmBytes: beforeGc.wasmBytes,
        p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
        p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
        p99Ms: Number(percentile(sorted, 0.99).toFixed(3)),
      }
      appendFileSync(outPath, `${JSON.stringify(line)}\n`)
      console.log(JSON.stringify(line))
      lastSample = now
    }
  }
} finally {
  await runtime.close()
}
