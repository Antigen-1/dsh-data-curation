import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/analyze-scheme-v2-soak.mjs <jsonl>')
  process.exit(2)
}
const samples = readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const errors = samples.reduce((sum, sample) => sum + (sample.errors || 0), 0)
const calls = samples.length > 0 ? samples[samples.length - 1].calls : 0
const last = samples[samples.length - 1]
const first = samples[0]
const tenMinutes = 10 * 60 * 1000
const early = samples.filter((sample) => sample.t >= 5 * 60 * 1000 && sample.t < 15 * 60 * 1000)
const late = samples.filter((sample) => sample.t >= last.t - tenMinutes)
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const earlyP95 = mean(early.map((sample) => sample.p95Ms))
const lateP95 = mean(late.map((sample) => sample.p95Ms))
const earlyP99 = mean(early.map((sample) => sample.p99Ms))
const lateP99 = mean(late.map((sample) => sample.p99Ms))

const lastThirty = samples.filter((sample) => sample.t >= last.t - 30 * 60 * 1000)
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

const report = {
  path,
  samples: samples.length,
  durationMs: last?.t ?? 0,
  calls,
  errors,
  first: first ? { t: first.t, rss: first.rss, p95Ms: first.p95Ms, p99Ms: first.p99Ms } : null,
  last: last ? { t: last.t, rss: last.rss, wasmBytes: last.wasmBytes, p95Ms: last.p95Ms, p99Ms: last.p99Ms } : null,
  earlyP95,
  lateP95,
  p95Ratio: earlyP95 > 0 ? Number((lateP95 / earlyP95).toFixed(3)) : null,
  earlyP99,
  lateP99,
  p99Ratio: earlyP99 > 0 ? Number((lateP99 / earlyP99).toFixed(3)) : null,
  rssSlopeMiBPerMin: rssSlope === null ? null : Number(rssSlope.toFixed(3)),
  rssMax: Math.max(...samples.map((sample) => sample.rss ?? 0)),
  rssLast: last?.rss ?? null,
  restarts: Math.max(...samples.map((sample) => sample.restarts ?? 0)),
  heartbeatAgeMaxMs: Math.max(...samples.map((sample) => sample.heartbeatAgeMs ?? 0)),
}
console.log(JSON.stringify(report, null, 2))
