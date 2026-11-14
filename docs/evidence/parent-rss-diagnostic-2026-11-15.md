# Parent RSS diagnostic — 0.22.2

Status: diagnostic only; not a 1h soak
Date: 2026-11-15
Code: 0.22.2 working tree
Node: v24.21.0 · Windows x64
Engine: `sha256:3f104d3573c0a8533b910f56fd484349dbc645fec3eac1435e722ed7210e983b`

## Question

0.22.1 final5 showed parent RSS baseline median 106.7 MiB → final median
148.8 MiB (+42.1 MiB), while child liveBytes and wasm were flat. Is this an
Emscripten/Wasm heap leak?

## Run

```text
node --expose-gc scripts/bench-scheme-v2-mixed.mjs
DSH_MIXED_MS=120000
DSH_MIXED_SAMPLE_MS=20000
DSH_MIXED_RSS_MS=5000
DSH_MIXED_SUPERVISED=1
DSH_MIXED_PARENT_GC=1
DSH_MIXED_OUT=experiments/parent-memory-diagnostic.jsonl
```

`DSH_MIXED_PARENT_GC=1` forces `global.gc()` immediately before each parent
memory sample. This is a diagnostic mode, not the production soak path.

## Result

| t (s) | calls | parent RSS MiB | heapUsed MiB | heapTotal MiB | external MiB | arrayBuffers MiB |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 12,737 | 59.0 | 8.4 | 19.8 | 2.6 | 0.2 |
| 40 | 25,447 | 66.9 | 9.0 | 27.8 | 2.6 | 0.2 |
| 60 | 38,187 | 68.6 | 9.4 | 27.8 | 2.6 | 0.2 |
| 80 | 50,915 | 80.0 | 9.8 | 43.5 | 2.6 | 0.2 |
| 100 | 63,627 | 57.3 | 9.8 | 15.5 | 2.6 | 0.2 |

## Interpretation

- `heapUsed` is essentially flat (8.4 → 9.8 MiB) while `heapTotal` and RSS move.
- Forced GC drops parent RSS from 80.0 to 57.3 MiB at the next sample.
- `external` and `arrayBuffers` are flat at 2.6/0.2 MiB; parent is not retaining
  a growing Wasm or Buffer pool.
- The child Wasm heap remains 60.4 MB and is not part of parent RSS.

Conclusion: parent RSS movement is Node/V8 page retention, not an
Emscripten/Wasm live-heap leak. 0.22.2 therefore records parent heap fields and
uses parent heap delta for the conditional guardrail when available; raw parent
RSS remains a 512 MiB hard cap/context metric. final5 is not retroactively
reclassified because it lacks parent heap fields.
