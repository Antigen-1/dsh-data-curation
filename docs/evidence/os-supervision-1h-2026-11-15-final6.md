# 0.22.2 final6 — Windows x64 1h supervised mixed soak

- Date: 2026-11-15
- Verdict: **PASS**
- Analyzer: `node scripts/analyze-scheme-v2-soak.mjs`
- Code commit: `d989293`
- Engine: `sha256:3f104d3573c0a8533b910f56fd484349dbc645fec3eac1435e722ed7210e983b`
- Node: v24.21.0
- OS: Windows NT 10.0.26300.0
- CPU: Intel64 Family 6 Model 198 Stepping 2, GenuineIntel

## Command

```powershell
$env:DSH_MIXED_MS = '3600000'
$env:DSH_MIXED_SUPERVISED = '1'
$env:DSH_MIXED_RSS_MS = '5000'
$env:DSH_MIXED_SAMPLE_MS = '60000'
$env:DSH_MIXED_PARENT_GC = '1'
$env:DSH_MIXED_OUT = 'experiments/scheme-v2-mixed-1h-livebytes-final6.jsonl'
node --expose-gc scripts/bench-scheme-v2-mixed.mjs
```

Raw evidence:

- `os-supervision-1h-2026-11-15-final6.jsonl`
- `os-supervision-1h-2026-11-15-final6-analysis.json`
- `os-supervision-1h-2026-11-15-final6-summary.json`

## Run summary

- Process duration: 3,600,110ms
- Samples: 59 (last sample at t=3,541,526ms; analyzer allows a 120s tail tolerance)
- Calls (final summary): 2,278,533
- Calls (last recorded sample): 2,241,547
- Errors: 0
- Restarts: 0
- GC stats errors: 0
- GC pause p95: 2.105ms
- Parent RSS max: 177,045,504B
- Wasm max: 60,424,192B

## liveBytes by runtime

| Runtime | Baseline median | Final median | Delta | Slope KiB/min | Slope upper95 | GC count | GC pause p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| static | 17,000,752 | 17,015,024 | +14,272 | +0.073 | 0.657 | 26→662 | 1.794ms |
| plugin | 17,016,872 | 17,015,072 | -1,800 | +0.021 | 0.770 | 19→193 | 2.083ms |
| program | 17,017,384 | 17,019,968 | +2,584 | -0.204 | 0.525 | 18→192 | 2.105ms |
| ffi | 17,016,880 | 17,015,328 | -1,552 | -0.152 | 0.629 | 22→428 | 2.076ms |

All four runtimes:

- `fullCollect: true`
- `maxGeneration: 4`
- `radix: 4`
- `gcCount` strictly increasing
- baseline samples = 20, final samples = 15
- pass = true

## Parent retention

- `parentGcSamples`: 59
- `parentHeapNormalized`: true
- `parentHeapDelta`: +177,324B (≈0.17MiB)
- `parentRssDelta`: -1,019,904B
- `parentRssMax`: 177,045,504B (< 512MiB hard cap)

The 32MiB conditional guardrail is evaluated on the GC-normalized parent
heap delta, not raw parent RSS. It is not triggered.

## finalGc context

The final full-GC pass is context only; acceptance uses liveBytes:

| Runtime | RSS before | RSS after |
|---|---:|---:|
| static | 72,220,672 | 72,220,672 |
| plugin | 50,429,952 | 50,974,720 |
| program | 59,645,952 | 59,654,144 |
| ffi | 86,675,456 | 86,675,456 |

The plugin and program RSS increases are V8/OS page motion, not Scheme live
set growth: liveBytes stayed within 1.6KB–14.3KB across the whole run.

## Analyzer verdict

```text
verdict: PASS
failures: []
conditional: []
```

This replaces the 0.22.1 final5 CONDITIONAL result. final5 is not
retroactively reclassified; it remains the historical 0.22.1 result.
