# OS supervision 1h mixed soak — final4

Date: 2026-11-14
Candidate: 0.22.0 (untagged)
Verdict: **NO-GO**

## Environment

- Node.js v24.21.0
- Windows NT 10.0.26300.0
- Intel64 Family 6 Model 198 Stepping 2, GenuineIntel
- Engine `sha256:8ec8aa06a20f2c0a3ea512ac39a9f1f787eca75d68dfe0481dadd040029f8c4b`
- Registry `sha256:e26e7e2413a1d968afa81f3dd8150a972835228363daa4851b784c7beca0be4c`
- Product code commit `5d91034`
- 4 supervised runtimes: static, plugin, program, ffi

## Command

```text
DSH_MIXED_MS=3600000
DSH_MIXED_SUPERVISED=1
DSH_MIXED_RSS_MS=5000
DSH_MIXED_OUT=experiments/scheme-v2-mixed-1h-supervised-final4.jsonl
node scripts/bench-scheme-v2-mixed.mjs
```

Raw evidence:

- `docs/evidence/os-supervision-1h-2026-11-14-final4.jsonl`
- `docs/evidence/os-supervision-1h-2026-11-14-final4-summary.json`
- `docs/evidence/os-supervision-1h-2026-11-14-final4-analysis.json`

## Result

```text
samples        120
durationMs     3,600,012
calls          2,280,907
errors         0
restarts       0
p95            13.1831 -> 12.9859 ms (0.985x)
p99            14.2958 -> 14.0184 ms (0.981x)
RSS peak       150,786,048 B
RSS last       82,878,464 B
heartbeat max  1,016 ms
Wasm           60,424,192 B constant
```

## Criteria

| # | Criterion | Result |
|---|---|---|
| 1 | errors=0, no restart | PASS |
| 2 | p95 late <= 1.5x early, p99 <= 2x | PASS |
| 3 | last 30 min RSS slope <= 2 MiB/min; no monotonic rise in the tail | **FAIL** |
| 4 | post-GC RSS <= pre-GC and <= 1.2x peak | **FAIL** |
| 5 | no heartbeat gap; window heartbeatAge < 3s | PASS |
| 6 | no uncaught exception, no process left | PASS |

## Failure detail

### Criterion 3 — tail is monotonic

The final 9 minutes rose monotonically:

```text
t=3,060,017  RSS 57,069,568 B
t=3,600,012  RSS 82,878,464 B
```

That is +25.8 MB in 8.5 minutes. The 30-minute aggregate slope is
+0.189 MiB/min, but the frozen criterion also forbids a monotonic tail.

### Criterion 4 — GC did not reduce RSS

```text
static   72,065,024 -> 72,073,216  (+8,192 B)
plugin   62,623,744 -> 62,631,936  (+8,192 B)
program  46,366,720 -> 46,374,912  (+8,192 B)
ffi      82,882,560 -> 82,886,656  (+4,096 B)
```

All four runtimes were individually collected; none returned to or below
the pre-GC value. The deltas are small, but the frozen criterion is strict:
`after <= before`. The run therefore fails.

## Decision

0.22.0 is not a production candidate. Do not tag, do not publish npm, and
do not describe the 1h evidence as passing. Per plan §7.1, do not start a
further soak automatically; a product-code change requires explicit user
approval and at most one re-run.
