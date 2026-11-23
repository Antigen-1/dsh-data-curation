# Scheme v2 mount sync audit — 0.26.0

Status: implementation candidate; independent document/code review pending.
Base release: `v0.25.0` (`0d5255f`).
Candidate commit: `62f2606 feat: harden mount sync paths and expose partial audit`.

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
  file and checks the opened real path again after `open`/`fstat`.
- `lib/rules/scheme/v2/worker.cjs` rechecks containment before `mkdir`, after
  resolving the parent real path, immediately before `rename`, and after the
  rename; deletes recheck the parent before and after removal. Failures use
  `E-MOUNT-SYNC-PATH`.
- `lib/rules/scheme/v2/sync-progress.js` aggregates `sync-progress` events into
  `{complete:false, reason, truncated, mounts[]}`. Path lists are capped at 2048
  entries across mounts; errors at 256 per mount.
- `client.js`, `supervisor.js`, and `supervisor-child.cjs` forward progress and
  attach the last snapshot as `error.partial` on timeout, exit, restart, close,
  or result error. `loader.js` exposes it as `runtime.syncPartial`.
- On timeout, `flushMounts` still fails closed: it marks the runtime closed and
  terminates the incarnation; the partial snapshot is diagnostic only.

## Verification

- `test/scheme-v2-mount.test.js`: 20/20.
- `test/scheme-v2-host-path.test.js`: 3/3.
- `test/scheme-v2-sync-progress.test.js`: 2/2.
- Standard full suite: 440 tests, 439 pass, 1 skip, 0 fail.
- `node scripts/selfcheck.mjs`: OK, 142 files.
- 1h soak: `experiments/scheme-v2-mount-path-1h-2026-11-24.jsonl`; analyzer
  verdict PASS (59 samples, 0 errors, 0 restarts, mount liveBytes stable).
- 5m large-file soak: `experiments/scheme-v2-mount-path-large-5m-2026-11-24.jsonl`;
  short analyzer PASS, output exactly 8,388,608 bytes.

## Residual limits

- A concurrent local writer can still race the final path check; there is no
  dirfd binding.
- The partial snapshot is an audit aid, not a transaction log. It cannot prove
  that unlisted files were untouched.
- The host directory is trusted; Wasm/Worker is not an OS security boundary.
- The runtime does not `fsync` synced files.

## Review record

- Document review: pending.
- Code review: pending.
- Fix verifier: pending.
