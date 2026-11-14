# 0.22.1 liveBytes evidence review record

Status: IMPLEMENTATION APPROVED; FINAL5 EVIDENCE **CONDITIONAL** (parent RSS guardrail)

Scope: commit `89a02db` relative to `7f4fc3d` (0.22.1 full-GC liveBytes
evidence path). This record covers the implementation review, the B1–B5 fixes,
and the bounded fix-verification. Release approval is a separate decision after
the final 1h run and evidence review.

## Implementation review

The independent implementation review returned **REVISE** with blocking
findings B1–B5 and high-priority findings H1–H4:

- B1 analyzer accepted too few samples and did not require `fullCollect`.
- B2 `gcStats` failures were not part of the error gate.
- B3 parent RSS and Wasm guardrails were not enforced.
- B4 supervised/worker/bare-vs-full/error tests were missing.
- B5 bootstrap sampling used an unseeded RNG.
- H1 GC pause was not part of the pass/fail gate.
- H2 GC counter semantics were documented inconsistently.
- H3 the debug gate was undocumented.
- H4 release docs/version were not updated.

## Fixes in 89a02db

- Analyzer requires baseline ≥20 and final ≥15 per runtime; slope needs at
  least two points; `fullCollect === true` and strictly increasing `gcCount`
  are required. `gcStatsErrors` and GC pause p95 are hard gates.
- Benchmark records parent RSS and per-runtime live/heap/Wasm/GC fields.
  `gcStats` failures increment sample errors. `lastMs` is captured before
  the GC sampling block.
- Guest exposes `gc-stats-json full?`; `pin-gc-stats` is debug-gated and
  performs full collection; `pin-gc-bare` exists only for the internal
  bare-vs-full test.
- Tests cover supervised `gcStats`, worker-tenant `gcStats`, bare-vs-full
  distinction, known live objects, and debug-disabled errors without killing
  the VM.
- Bootstrap uses a SHA-256-derived seed from the JSONL bytes.
- Documentation records cumulative counter semantics, the debug gate, and
  the distinction between `liveBytes` and OS RSS.

## Fix verification

The independent fix-verifier reviewed commit `89a02db` against `7f4fc3d`
read-only and returned **APPROVE** with `blocking: []`.

Non-blocking notes:

- The pre-existing duration tolerance allows a 58-minute synthetic run to
  pass. final5 uses the full 3,600,000 ms command, and the evidence records
  the actual duration.
- A failure of the final `finalGc` call is recorded in stdout but not in the
  JSONL sample error gate; per-sample `gcStats` failures are gated.
- `wasmMax` currently scans the final window; safe because Wasm does not
  shrink and restarts are a hard failure.
- `gcStatsBare()` is reachable through the internal `runtime.vm` object; it
  is test-only and enables the debug flag by dispatch.

## Evidence status

final5 completed on code `89a02db`, engine `3f104d...`, Node v24.21.0,
Windows x64. The analyzer verdict is **CONDITIONAL**: all four runtimes pass
the full-GC liveBytes criteria (flat/slightly lower live set, strict gcCount,
fullCollect true, no errors/restarts), but parent RSS rose from a 106.7 MiB
baseline median to 149.5 MiB final median (+42.8 MiB), exceeding the 32 MiB
conditional guardrail.

Evidence:

- `docs/evidence/os-supervision-1h-2026-11-15-final5.md`
- `docs/evidence/os-supervision-1h-2026-11-15-final5.jsonl`
- `docs/evidence/os-supervision-1h-2026-11-15-final5-summary.json`
- `docs/evidence/os-supervision-1h-2026-11-15-final5-analysis.json`

This is not an APPROVE of the final 1h evidence as production proof. The
parent RSS growth must be investigated; no automatic rerun is allowed.
