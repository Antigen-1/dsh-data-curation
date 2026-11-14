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
