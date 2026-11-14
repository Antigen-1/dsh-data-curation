# 0.22.2 parent heap / RSS evidence review

- Date: 2026-11-15
- Scope: commit `1a96af7` only (parent `d45c3c7`)
- Reviewer: independent read-only subagent
- Verdict: **APPROVE**, blocking = 0

## Reviewed change

Separates Node/V8 parent heap retention from raw parent RSS in the 1h soak
evidence path:

- bench records `parentMemory {rss, heapTotal, heapUsed, external, arrayBuffers}`
  and `parentGc`, and supports `DSH_MIXED_PARENT_GC=1`;
- analyzer uses the 32MiB conditional guardrail on GC-normalized parent heap
  delta only when forced-GC samples exist; otherwise it falls back to raw
  parent RSS;
- raw parent RSS keeps the 512MiB hard cap;
- final5 has no heap fields and remains **CONDITIONAL** (not reclassified).

The review excluded all earlier 0.22.1 changes.

## Findings

Blocking: none.

Non-blocking:

1. The docs quoted the final5 parent median as 149.5MiB/+42.8MiB; the
   analyzer reports 148.8MiB/+42.1MiB. The verdict is unchanged, but the
   figures were corrected in the affected docs.
2. In forced-GC mode, the 512MiB hard cap sees post-GC parent RSS. That is
   diagnostic-only; do not use forced-GC mode as raw-RSS release evidence.
3. `DSH_MIXED_PARENT_GC=1` without `node --expose-gc` silently falls back to
   raw RSS. Conservative, but it should warn.
4. The GC-normalized branch trusts present-but-zero `heapUsed`; hardening only,
   since the bench cannot emit zero heapUsed.
5. `parentHeapUsedMax` is reported as 0 instead of null when parentMemory is
   absent.
6. No automated fixture test covers the new forced-GC/fallback branch.
7. The diagnostic run block places env assignments after `node`, so it is not
   directly executable as written.

## Verification

The reviewer re-ran the analyzer on committed final5:

- `parentGcSamples=0`
- `parentHeapNormalized=false`
- `parentRssDelta=44132352` (42.09MiB)
- verdict remains **CONDITIONAL**

No product code was changed by the review. Only the final5 median figures in
docs were corrected from 149.5MiB/+42.8MiB to 148.8MiB/+42.1MiB.

## final6 release evidence

The reviewed 0.22.2 path was then exercised by one final Windows x64
supervised soak (`final6`, commit `d989293`, engine `3f104d...`):

- analyzer verdict: **PASS**
- 59 samples, process duration 3,600,110ms, 2,241,547 calls at the last
  sample (2,278,533 final), 0 error, 0 restart
- liveBytes flat for all four runtimes: static +14,272B, plugin -1,800B,
  program +2,584B, ffi -1,552B; slope upper95 < 0.8KiB/min
- GC pause p95: 2.105ms; fullCollect true; gcCount strictly increasing
- parent heap normalized: 59 samples, +177,324B (≈0.17MiB), no 32MiB
  conditional; parent RSS max 177,045,504B; wasm 60,424,192B
- final5 remains the historical CONDITIONAL 0.22.1 result

Evidence: `docs/evidence/os-supervision-1h-2026-11-15-final6.md` and its
JSONL/analysis/summary siblings.

