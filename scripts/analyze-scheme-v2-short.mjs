import { readFileSync } from 'node:fs'

// A short stress soak checks behavior under a larger working set; it is not a
// substitute for the one-hour candidate soak. Keep its gates explicit and
// narrower than analyze-scheme-v2-soak.mjs.
const jsonlPath = process.argv[2]
const summaryPath = process.argv[3]
if (!jsonlPath) {
  console.error('usage: node scripts/analyze-scheme-v2-short.mjs <jsonl> [summary.json]')
  process.exit(2)
}

const samples = readFileSync(jsonlPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .sort((a, b) => a.t - b.t)
if (samples.length === 0) throw new Error('no soak samples')
const summary = summaryPath ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null
const last = samples.at(-1)
const first = samples[0]
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}
const failures = []
const MAX_RUNTIME_RSS = 512 * 1024 * 1024
const MAX_RUNTIME_WASM = 448 * 1024 * 1024
const durationMs = last.t
const window = Math.max(1, Math.floor(samples.length / 3))
const baselineSamples = samples.slice(0, window)
const finalSamples = samples.slice(-window)
if (durationMs < 240000) failures.push(`duration ${durationMs}ms < 240000ms`)
if (samples.length < 20) failures.push(`samples ${samples.length} < 20`)
if (last.errors !== 0) failures.push(`errors ${last.errors}`)
if (last.restarts !== 0) failures.push(`restarts ${last.restarts}`)

const names = Object.keys(first.liveBytesByRuntime || {}).sort()
const perRuntime = {}
for (const name of names) {
  const baseline = baselineSamples
    .map((sample) => sample.liveBytesByRuntime?.[name])
    .filter((value) => typeof value === 'number')
  const final = finalSamples
    .map((sample) => sample.liveBytesByRuntime?.[name])
    .filter((value) => typeof value === 'number')
  const rss = samples
    .map((sample) => sample.rssByRuntime?.[name]?.rss ?? sample.rssByRuntime?.[name]?.resource?.rss)
    .filter((value) => typeof value === 'number')
  const wasm = samples
    .map((sample) => sample.rssByRuntime?.[name]?.wasmBytes ?? sample.rssByRuntime?.[name]?.resource?.wasmBytes)
    .filter((value) => typeof value === 'number')
  const baselineMedian = median(baseline)
  const finalMedian = median(final)
  const delta = finalMedian - baselineMedian
  if (Math.abs(delta) > 4 * 1024 * 1024) {
    failures.push(`${name} liveBytes delta ${delta} exceeds 4MiB`)
  }
  if (rss.length && Math.max(...rss) > MAX_RUNTIME_RSS) {
    failures.push(`${name} RSS max ${Math.max(...rss)} exceeds 512MiB`)
  }
  if (wasm.length && Math.max(...wasm) > MAX_RUNTIME_WASM) {
    failures.push(`${name} Wasm max ${Math.max(...wasm)} exceeds 448MiB`)
  }
  perRuntime[name] = {
    samples: baseline.length + final.length,
    baselineMedian,
    finalMedian,
    delta,
    rssMax: rss.length ? Math.max(...rss) : null,
    wasmMax: wasm.length ? Math.max(...wasm) : null,
  }
}

const p95Ratio = first.p95Ms > 0 ? last.p95Ms / first.p95Ms : null
if (p95Ratio !== null && p95Ratio > 3) failures.push(`p95 ratio ${p95Ratio} > 3`)

const mount = perRuntime.mount || null
if (summary) {
  if (summary.errors !== 0) failures.push(`summary errors ${summary.errors}`)
  if (summary.mountFlushErrors !== 0) failures.push(`mountFlushErrors ${summary.mountFlushErrors}`)
  if (!(summary.mountCalls > 0)) failures.push('no mount calls')
  if (!(summary.mountFlushes > 0)) failures.push('no flushMounts calls')
  if (summary.mountOutputBytesExpected === undefined) {
    failures.push('summary has no expected mount output size')
  } else if (summary.mountHostAOutBytes !== summary.mountOutputBytesExpected) {
    failures.push(`host output ${summary.mountHostAOutBytes} != expected ${summary.mountOutputBytesExpected}`)
  }
}

const report = {
  scope: 'short stress soak; not a one-hour candidate soak',
  path: jsonlPath,
  summaryPath: summaryPath || null,
  samples: samples.length,
  durationMs,
  calls: last.calls,
  errors: last.errors,
  restarts: last.restarts,
  parentRssMax: Math.max(...samples.map((sample) => sample.parentRss ?? 0)),
  p95Ratio,
  perRuntime,
  mount,
  mountHostAOutBytes: summary?.mountHostAOutBytes ?? null,
  mountOutputBytesExpected: summary?.mountOutputBytesExpected ?? null,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  failures,
}
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exit(1)
