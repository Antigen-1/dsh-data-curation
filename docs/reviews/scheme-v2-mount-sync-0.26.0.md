# Scheme v2 mount sync audit — 0.26.0

Status: independent review completed; review fixes applied; fix verifier APPROVE;
final 1h and 5m soaks PASS. 0.26.0 is an untagged candidate.
Base release: annotated tag `v0.25.0`, tag object `6a4b2b6`, commit `0d5255f`.
Candidate code: `62f2606 feat: harden mount sync paths and expose partial audit`;
post-review fixes: `39dbd4d fix: close 0.26 mount sync review findings`.
Review record: commit `7540037`; the current revision includes post-review fixes.

## Scope

This candidate addresses two limitations recorded for `0.25.0`:

1. residual `lstat`/`open`/`rename` TOCTOU between a mount's host root and
   sync writes;
2. no partial audit when a sync times out, the worker exits, or the supervisor
   restarts.

The fix is deliberately pure Node. It is best-effort hardening, not a
kernel-enforced boundary: Node exposes no `openat`/`renameat2`, and Windows has
no `O_NOFOLLOW`. The host directory remains trusted; this closes ordinary static
and symlink/junction escapes, not every concurrent race.

## Implementation

- `lib/rules/scheme/v2/host-path.cjs` centralizes containment and realpath
  checks. `assertHostTarget` rejects a missing target when `allowMissing:false`
  and requires the nearest existing ancestor to resolve inside the root.
- `lib/rules/scheme/v2/mount-lib.js` checks the target before opening a mounted
  file and resolves the path name again after `open`/`fstat`. This is a second
  path-name realpath check, not an `openat` descriptor check.
- `lib/rules/scheme/v2/worker.cjs` rechecks containment before `mkdir`, after
  resolving the parent real path, immediately before `rename`, and after the
  rename; deletes recheck the parent before and after removal. Failures use
  `E-MOUNT-SYNC-PATH`.
- `lib/rules/scheme/v2/sync-progress.js` aggregates `sync-progress` events into
  `{complete:false, reason, truncated, mounts[]}`. Written/deleted path lists are
  capped at 2048 entries across mounts; errors at 256 per mount. Error paths do
  not consume the 2048 budget. The `file-errors` snapshot synthesized from a
  successful result may have empty path arrays and no `files`; its counts and
  errors are authoritative.
- `client.js` and `supervisor.js` aggregate progress and attach the last
  snapshot as `error.partial` on timeout, exit, restart, close, or result error;
  `supervisor-child.cjs` only forwards `sync-progress` events. `loader.js`
  exposes it as `runtime.syncPartial`.
- On timeout, `flushMounts` still fails closed: it marks the runtime closed and
  terminates the incarnation; the partial snapshot is diagnostic only.

## Verification

- `test/scheme-v2-mount.test.js`: 20/20.
- `test/scheme-v2-host-path.test.js`: 3/3.
- `test/scheme-v2-sync-progress.test.js`: 2/2.
- Standard full suite: 440 tests, 439 pass, 1 skip, 0 fail.
- `node scripts/selfcheck.mjs`: OK, 143 files.
- 1h soak on the final tree (`39dbd4d`):
  `experiments/scheme-v2-mount-path-final-1h-2026-11-24.jsonl`; analyzer PASS:
  59 samples, 2,262,077 calls, 90,484 mount calls, 180 flushes, 0 errors,
  0 restarts; mount liveBytes 17,762,280 → 18,462,688, delta 700,408 bytes,
  slope upper 0.364 KiB/min.
- 5m large-file soak on the final tree (`39dbd4d`):
  `experiments/scheme-v2-mount-path-final-large-5m-2026-11-24.jsonl`; short
  analyzer PASS, 190,117 calls, 0 errors, output exactly 8,388,608 bytes.
- The earlier `62f2606` soak results remain in `experiments/` as pre-fix
  history; they are not the release evidence.

## Residual limits

- A concurrent local writer can still race the final path check; there is no
  dirfd binding.
- The partial snapshot is an audit aid, not a transaction log. It cannot prove
  that unlisted files were untouched.
- The host directory is trusted; Wasm/Worker is not an OS security boundary.
- The runtime does not `fsync` synced files.

## Review record

### Independent code review — REJECT

- HIGH: Windows junction/non-native realpath could escape containment; local
  `host-path` tests were 3/3 and a manual junction probe resolved outside, so
  the reviewer’s exact reproduction was not confirmed. The hardening was still
  adopted: `realpathNative` now prefers `fs.realpathSync.native`.
- LOW: the `file-errors` snapshot was synthetic; the `writeAtomic` fallback could
  swallow a new path-check failure; shared error objects could mix concurrent
  partial snapshots; `syncPathError` used `E-MOUNT-SYNC`; unused
  `assertSyncParent`; missing 2048/256 end-to-end, concurrent, exit/restart/close
  and success-clear tests.
- Fixed: native realpath, `E-MOUNT-SYNC-PATH`, recheck before fallback, independent
  per-waiter errors, synthetic snapshot docs/`files`, and the new timeout test.
  Remaining test depth is recorded in the plan; no new HIGH is open.

### Independent document review — REJECT

- HIGH: MEMFS doc claimed static symlink/junction escapes were closed; Windows
  behavior was not proven.
- MEDIUM: review record had stale counts and commit bindings; partial `files`
  optionality/path-budget and `file-errors` semantics were overclaimed.
- LOW: “opened real path” wording, missing TENANT `syncTimeoutMs`/partial, plan
  `error.details.partial`/reason enum/AC drift.
- Fixed: docs now distinguish path-name recheck from an opened descriptor, state
  the 2048/256 limits precisely, document `file-errors`, TENANT sync/partial,
  and align the plan. Base/tag and candidate bindings are corrected above.

### Fix verifier — APPROVE

- No HIGH introduced by the post-review diff. The six prior findings were
  substantively fixed: native realpath, `E-MOUNT-SYNC-PATH`, writeAtomic fallback
  recheck, independent per-waiter errors, synthetic-snapshot docs, and binding
  corrections.
- M1/M2 fixed: mount tests are recorded as 20/20 (host-path 3/3 separately), and
  the TENANT doc no longer claims a `.runtime` accessor or unconditional
  `.partial`.
- L1 fixed: the synthetic file-errors snapshot caps errors at 256 per mount and
  sets `truncated`; L4 wording corrected. Remaining L2/L3 are plan drift and a
  missing committed mount-level junction regression; they do not block this
  candidate.
- Residual risk remains the documented concurrent TOCTOU and non-transactional
  partial audit. No tag, no npm publish.
