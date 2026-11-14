import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/analyze-scheme-v2-soak.mjs <jsonl>')
  process.exit(2)
}
const raw = readFileSync(path, 'utf8')
const samples = raw
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .sort((a, b) => a.t - b.t)
let randomState = createHash('sha256').update(raw).digest().readUInt32LE(0) || 1
const random = () => {
  randomState ^= randomState << 13
  randomState ^= randomState >>> 17
  randomState ^= randomState << 5
  return (randomState >>> 0) / 0x100000000
}

const last = samples.at(-1)
const first = samples[0]
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
const quantile = (values, q) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]
}
const theilSen = (points) => {
  if (points.length < 2) return null
  const slopes = []
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dt = (points[j].t - points[i].t) / 60000
      if (dt !== 0) slopes.push((points[j].value - points[i].value) / dt)
    }
  }
  return slopes.length === 0 ? null : median(slopes)
}
const bootstrapUpper = (points, rounds = 1000) => {
  if (points.length < 2) return null
  const slopes = []
  for (let round = 0; round < rounds; round += 1) {
    const resample = Array.from({ length: points.length }, () => points[Math.floor(random() * points.length)])
    const slope = theilSen(resample)
    if (slope !== null) slopes.push(slope)
  }
  return slopes.length === 0 ? null : quantile(slopes, 0.95)
}

const durationMs = last?.t ?? 0
const errors = last?.errors ?? 0
const calls = last?.calls ?? 0
const gcStatsErrors = samples.reduce((sum, sample) => sum + Object.values(sample.rssByRuntime ?? {})
  .filter((entry) => entry?.gcStatsError != null).length, 0)
const warmupEnd = 10 * 60 * 1000
const baselineStart = 10 * 60 * 1000
const baselineEnd = 30 * 60 * 1000
const baseline = samples.filter((sample) => sample.t >= baselineStart && sample.t < baselineEnd)
const final = samples.filter((sample) => sample.t >= durationMs - 15 * 60 * 1000)
const lastThirty = samples.filter((sample) => sample.t >= durationMs - 30 * 60 * 1000)
const runtimeNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.liveBytesByRuntime ?? {})))]
const rssNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.rssByRuntime ?? {})))]

const perRuntime = {}
for (const name of runtimeNames) {
  const points = lastThirty
    .map((sample) => ({ t: sample.t, value: sample.liveBytesByRuntime?.[name] }))
    .filter((point) => Number.isFinite(point.value))
  const baselineLive = baseline
    .map((sample) => sample.liveBytesByRuntime?.[name])
    .filter(Number.isFinite)
  const finalLive = final
    .map((sample) => sample.liveBytesByRuntime?.[name])
    .filter(Number.isFinite)
  const gcCounts = samples
    .map((sample) => sample.rssByRuntime?.[name]?.gcCount)
    .filter(Number.isFinite)
  const fullCollectOk = samples.length > 0 && samples.every((sample) => {
    const entry = sample.rssByRuntime?.[name]
    return entry?.fullCollect === true
  })
  const baselineMedian = median(baselineLive)
  const finalMedian = median(finalLive)
  const delta = baselineMedian === null || finalMedian === null ? null : finalMedian - baselineMedian
  const slope = theilSen(points)
  const upper = bootstrapUpper(points)
  const gcCountStrictlyIncreasing = gcCounts.length >= 2 &&
    gcCounts.every((value, index) => index === 0 || value > gcCounts[index - 1])
  const gcDurations = samples
    .map((sample) => sample.rssByRuntime?.[name]?.gcStatsDurationMs)
    .filter(Number.isFinite)
  const gcPauseP95Ms = quantile(gcDurations, 0.95)
  perRuntime[name] = {
    samples: points.length,
    baselineSamples: baselineLive.length,
    finalSamples: finalLive.length,
    baselineMedian,
    finalMedian,
    delta,
    slopeKiBPerMin: slope === null ? null : Number((slope / 1024).toFixed(3)),
    slopeUpper95KiBPerMin: upper === null ? null : Number((upper / 1024).toFixed(3)),
    gcCountFirst: gcCounts[0] ?? null,
    gcCountLast: gcCounts.at(-1) ?? null,
    gcCountStrictlyIncreasing,
    gcPauseP95Ms: gcPauseP95Ms === null ? null : Number(gcPauseP95Ms.toFixed(3)),
    fullCollectOk,
    pass:
      points.length >= 2 &&
      baselineLive.length >= 20 &&
      finalLive.length >= 15 &&
      delta !== null &&
      delta <= 1024 * 1024 &&
      upper !== null &&
      upper / 1024 < 32 &&
      gcCountStrictlyIncreasing &&
      fullCollectOk,
  }
}

const rssGuardrail = {}
for (const name of rssNames) {
  const baselineRss = baseline
    .map((sample) => sample.rssByRuntime?.[name]?.rss)
    .filter(Number.isFinite)
  const finalRss = final
    .map((sample) => sample.rssByRuntime?.[name]?.rss)
    .filter(Number.isFinite)
  const baselineMedian = median(baselineRss)
  const finalMedian = median(finalRss)
  const delta = baselineMedian === null || finalMedian === null ? null : finalMedian - baselineMedian
  const liveDelta = perRuntime[name]?.delta ?? null
  const heapValues = final.map((sample) => sample.rssByRuntime?.[name]?.heapReservedBytes).filter(Number.isFinite)
  const heapBaseline = baseline.map((sample) => sample.rssByRuntime?.[name]?.heapReservedBytes).filter(Number.isFinite)
  const heapDelta = median(heapValues) === null || median(heapBaseline) === null
    ? null
    : median(heapValues) - median(heapBaseline)
  const parentBaseline = baseline.map((sample) => sample.parentRss).filter(Number.isFinite)
  const parentFinal = final.map((sample) => sample.parentRss).filter(Number.isFinite)
  const parentDelta = median(parentBaseline) === null || median(parentFinal) === null
    ? null
    : median(parentFinal) - median(parentBaseline)
  const wasmValues = final.map((sample) => sample.rssByRuntime?.[name]?.wasmBytes).filter(Number.isFinite)
  rssGuardrail[name] = {
    baselineMedian,
    finalMedian,
    delta,
    liveDelta,
    heapDelta,
    parentDelta,
    parentMax: samples.map((sample) => sample.parentRss).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), 0),
    wasmMax: wasmValues.reduce((max, value) => Math.max(max, value), 0),
    conditional:
      (delta !== null && delta > 32 * 1024 * 1024 && (liveDelta === null || Math.abs(liveDelta) <= 1024 * 1024)) ||
      (parentDelta !== null && parentDelta > 32 * 1024 * 1024),
  }
}

const early = samples.filter((sample) => sample.t >= 5 * 60 * 1000 && sample.t < 15 * 60 * 1000)
const late = final
const earlyP95 = mean(early.map((sample) => sample.p95Ms).filter(Number.isFinite))
const lateP95 = mean(late.map((sample) => sample.p95Ms).filter(Number.isFinite))
const earlyP99 = mean(early.map((sample) => sample.p99Ms).filter(Number.isFinite))
const lateP99 = mean(late.map((sample) => sample.p99Ms).filter(Number.isFinite))
const rssSlope = (() => {
  if (lastThirty.length < 2) return null
  const xs = lastThirty.map((sample) => sample.t / 60000)
  const ys = lastThirty.map((sample) => sample.rss / 1024 / 1024)
  const xMean = mean(xs)
  const yMean = mean(ys)
  const numerator = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0)
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0)
  return denominator === 0 ? 0 : numerator / denominator
})()

const failures = []
if (samples.length < 50) failures.push('fewer than 50 samples')
if (durationMs < 3600 * 1000 - 120 * 1000) failures.push(`duration ${durationMs}ms is below 1h`)
if (errors !== 0) failures.push(`${errors} errors`)
if (gcStatsErrors !== 0) failures.push(`${gcStatsErrors} gcStats errors`)
if ((last?.restarts ?? 0) !== 0) failures.push(`${last.restarts} restarts`)
for (const [name, result] of Object.entries(perRuntime)) {
  if (!result.pass) failures.push(`${name} liveBytes criterion failed`)
  if (result.gcPauseP95Ms !== null && result.gcPauseP95Ms > 100) {
    failures.push(`${name} gcStats p95 ${result.gcPauseP95Ms}ms exceeds 100ms`)
  }
}
if (Object.keys(perRuntime).length === 0) failures.push('no liveBytes data')
for (const [name, result] of Object.entries(rssGuardrail)) {
  if (result.parentMax > 512 * 1024 * 1024) failures.push(`${name} parent RSS exceeds 512MiB`)
  if (result.wasmMax > 512 * 1024 * 1024) failures.push(`${name} wasm exceeds 512MiB`)
}
const conditional = Object.entries(rssGuardrail)
  .filter(([, result]) => result.conditional)
  .map(([name]) => name)

const report = {
  path,
  samples: samples.length,
  durationMs,
  calls,
  errors,
  gcStatsErrors,
  gcPauseP95Ms: quantile(Object.values(perRuntime).map((entry) => entry.gcPauseP95Ms).filter(Number.isFinite), 0.95),
  parentRssMax: Math.max(...samples.map((sample) => sample.parentRss ?? 0)),
  warmupEndMs: warmupEnd,
  baselineWindowMs: [baselineStart, baselineEnd],
  finalWindowMs: [Math.max(0, durationMs - 15 * 60 * 1000), durationMs],
  first: first ? { t: first.t, rss: first.rss, p95Ms: first.p95Ms, p99Ms: first.p99Ms } : null,
  last: last ? { t: last.t, rss: last.rss, wasmBytes: last.wasmBytes, p95Ms: last.p95Ms, p99Ms: last.p99Ms } : null,
  p95Ratio: earlyP95 > 0 ? Number((lateP95 / earlyP95).toFixed(3)) : null,
  p99Ratio: earlyP99 > 0 ? Number((lateP99 / earlyP99).toFixed(3)) : null,
  rssSlopeMiBPerMin: rssSlope === null ? null : Number(rssSlope.toFixed(3)),
  rssMax: Math.max(...samples.map((sample) => sample.rss ?? 0)),
  rssLast: last?.rss ?? null,
  restarts: Math.max(...samples.map((sample) => sample.restarts ?? 0)),
  heartbeatAgeMaxMs: Math.max(...samples.map((sample) => sample.heartbeatAgeMs ?? 0)),
  perRuntime,
  rssGuardrail,
  verdict: failures.length > 0 ? 'FAIL' : conditional.length > 0 ? 'CONDITIONAL' : 'PASS',
  failures,
  conditional,
}
console.log(JSON.stringify(report, null, 2))
