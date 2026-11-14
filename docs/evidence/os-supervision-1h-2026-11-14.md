# OS supervision 1h evidence — 2026-11-14

Status: **PASS** for Windows x64 + Node 24.

Candidate code: `ae5aa937374565d6420e1707f2126fcfae907d2f` (`fix: harden supervised resource lifecycle (0.22.0)`).

## Environment

| Item | Value |
|---|---|
| OS | Microsoft Windows NT 10.0.26300.0 |
| CPU | Intel64 Family 6 Model 198 Stepping 2, GenuineIntel |
| Node | v24.21.0 |
| Engine | `sha256:8ec8aa06a20f2c0a3ea512ac39a9f1f787eca75d68dfe0481dadd040029f8c4b` |
| Engine registry SHA-256 | `e26e7e2413a1d968afa81f3dd8150a972835228363daa4851b784c7beca0be4c` |
| Isolation | 4 supervised OS child processes (`CvmSupervisor`), one per runtime |
| Workload | 70% static rule / 20% plugin / 10% program, FFI every 10 calls |

## Command

```powershell
$env:PATH = 'C:\Users\29436\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin;' + $env:PATH
$env:DSH_MIXED_MS = '3600000'
$env:DSH_MIXED_SUPERVISED = '1'
$env:DSH_MIXED_RSS_MS = '5000'
$env:DSH_MIXED_OUT = 'experiments/scheme-v2-mixed-1h-supervised-final3.jsonl'
node scripts/bench-scheme-v2-mixed.mjs
```

Start/end: 2026-11-14 18:04:47 → 19:04:54 local (Asia/Shanghai).

## Evidence files

- `docs/evidence/os-supervision-1h-2026-11-14.jsonl` — 120 windows, 30s each.
- `docs/evidence/os-supervision-1h-2026-11-14-summary.json` — analyzer output.
- `experiments/mixed-1h-final3.out.log` — final process summary and post-GC metrics (not tracked).

## Result

| Metric | Value |
|---|---|
| Duration | 3,600,010 ms |
| Calls | 2,200,847 |
| Static / plugin / program / FFI | 1,540,595 / 440,168 / 220,084 / 220,085 |
| Errors | 0 |
| Restarts | 0 |
| p95 (early → late) | 13.616 → 11.971 ms (0.879×) |
| p99 (early → late) | 14.289 → 16.951 ms (1.186×) |
| RSS first / last / max | 143,335,424 / 89,960,448 / 147,922,944 B |
| RSS last-30min slope | +0.843 MiB/min (5 drops in 61 windows; not monotonic) |
| Wasm bytes | 60,424,192 constant |
| Heartbeat age max | 1,000 ms |
| Post-GC RSS | 65,490,944 B (below pre-GC 85.8 MiB; below peak) |
| GCs | 1 (final only) |

## Pass criteria (§5.2)

1. `errors=0`, no `E-RESOURCE-*`, no restart — PASS.
2. Late/early p95 0.879× ≤ 1.5×; p99 1.186× ≤ 2× — PASS.
3. RSS last-30min slope +0.843 MiB/min ≤ 2 MiB/min; 5 drops in the last 30 minutes — PASS.
4. Post-GC RSS 65.5 MB ≤ pre-GC 85.8 MB and ≤ 1.2× peak — PASS; Wasm constant — PASS.
5. Heartbeat age max 1,000 ms < 3 s; no heartbeat kill — PASS.
6. No uncaught exception; soak process exited normally — PASS.

## Caveats

- This is a Windows x64 + Node 24 result. macOS is not verified; Linux x64 has a 10-minute smoke from the pre-fix tree, not a final-tree 1h result. WSL currently returns `Wsl/E_ACCESSDENIED`, so the final-tree Linux rerun could not be executed in this environment.
- RSS is sampled every 5 s by the supervisor; kill is a supervised limit, not an OS Job Object hard cap.
- FFI provider execution can continue external side effects after a timeout kill; this is documented as a residual risk.
