# 0.22.1 final5 — 1h supervised mixed soak, liveBytes evidence

Status: **CONDITIONAL — liveBytes PASS, parent RSS guardrail requires investigation**
Date: 2026-11-15
Code commit: `89a02db`
Engine: `sha256:3f104d3573c0a8533b910f56fd484349dbc645fec3eac1435e722ed7210e983b`
Node: v24.21.0 · Windows NT 10.0.26300.0 · x64

## Run

```text
DSH_MIXED_MS=3600000
DSH_MIXED_SUPERVISED=1
DSH_MIXED_RSS_MS=5000
DSH_MIXED_SAMPLE_MS=60000
DSH_MIXED_OUT=experiments/scheme-v2-mixed-1h-livebytes-final5.jsonl
```

Four supervised runtimes: static, plugin, program, ffi. One run only; no automatic rerun.

## Result

- Process duration: 3,600,124 ms; finished with exit 0.
- Calls: 2,287,047 (static 1,600,935 / plugin 457,408 / program 228,704 / ffi 228,705).
- Errors: 0; restarts: 0.
- Samples: 59 at 60s cadence; last sample at 3,541,390 ms. The process ended at 3,600,124 ms. The final 60th sample was not emitted; the 20/15 baseline/final windows are intact.
- Analyzer verdict: **CONDITIONAL** — no liveBytes failure, all four runtimes pass the live criteria. Parent RSS guardrail fires for all four (same parent process).

## liveBytes (per runtime)

| Runtime | baseline median | final median | delta | slope KiB/min | upper95 KiB/min | fullCollect | gcCount strict | pass |
|---|---:|---:|---:|---:|---:|---|---|---|
| static | 17,013,352 | 17,001,952 | -11,400 | -0.379 | 0.208 | true | true | true |
| plugin | 17,012,912 | 17,011,712 | -1,200 | -0.453 | 0.286 | true | true | true |
| program | 17,022,008 | 17,019,600 | -2,408 | -0.234 | 0.456 | true | true | true |
| ffi | 17,016,280 | 17,010,992 | -5,288 | -0.218 | 0.695 | true | true | true |

GC pause p95 across runtimes: 3.563 ms; observed max `gcStatsDurationMs` 23.81 ms.

## finalGc

All four runtimes performed a full collect at the end:

| Runtime | liveBytes | heapReservedBytes | gcCount | fullCollect | child RSS before → after |
|---|---:|---:|---:|---|---|
| static | 16,994,992 | 28,607,208 | 674 | true | 74,252,288 → 74,252,288 |
| plugin | 17,010,752 | 30,737,184 | 196 | true | 61,640,704 → 61,943,808 |
| program | 17,000,880 | 26,477,232 | 195 | true | 45,457,408 → 45,502,464 |
| ffi | 17,039,680 | 26,477,232 | 435 | true | 81,354,752 → 81,354,752 |

This table is the source of truth for “GC 后 live 是否增长”; OS RSS is not used as the live-set criterion.

## Why CONDITIONAL

The live set is flat or slightly lower in every runtime, full collection is true, gcCount increases strictly, and there are no errors or restarts. However the **parent/orchestrator RSS** rose:

- parent baseline median (10–30 min): 106.7 MiB
- parent final median (last 15 min): 148.8 MiB
- delta: **+42.1 MiB** (> 32 MiB conditional threshold)
- parent max: 169.6 MiB; child RSS values ended lower than baseline.

The plan says a parent/child RSS delta above 32 MiB while liveBytes/heapReserved/wasm are flat is **CONDITIONAL** and must be investigated. It is not a live-set leak and not a hard 512 MiB breach. Do not describe final5 as PASS.

## Artifacts

- `docs/evidence/os-supervision-1h-2026-11-15-final5.jsonl`
- `docs/evidence/os-supervision-1h-2026-11-15-final5-summary.json`
- `docs/evidence/os-supervision-1h-2026-11-15-final5-analysis.json`
- analyzer: `scripts/analyze-scheme-v2-soak.mjs`

## Next

Investigate parent RSS growth (V8 heap, benchmark accumulation, or supervisor bookkeeping) before any further production claim. No automatic rerun; final5 remains the one-run evidence.
