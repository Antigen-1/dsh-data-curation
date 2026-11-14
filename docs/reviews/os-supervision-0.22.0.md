# 0.22.0 OS supervision review record

Status: **CONDITIONAL — fix-verification pending on final tree**  
Reviewed tree: `03d8b0d9c85de710ca7361a95072f2fd9c40e8cc`  
Fixed code: `82ab855` (supersedes `ae5aa93`; resource-limit tests and pre-soak fixes)  
Evidence commit: `f6ef7cf332964c817abf7fddb7b1e3046277cfb0`

Three independent read-only reviewers (security, code, release) reviewed the
0.22.0 supervision/lifecycle change. None returned APPROVE; all returned
CONDITIONAL. The findings below were fixed in `ae5aa93` and `82ab855`; final
fix-verification and a fresh 1h soak on `82ab855` are still required.

## Closure summary

- HIGH findings: closed in code; fix-verification still required.
- MEDIUM findings: closed or explicitly documented.
- Pre-fix Windows 1h at `ae5aa93`: PASS. Final 1h on `82ab855`: pending.
- Linux final-tree 10min rerun: not possible because WSL returns
  `Wsl/E_ACCESSDENIED`; the prior 10min result is from the pre-fix tree and is
  labelled as such.

## Security findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| S1 | HIGH | `terminate()` / command timeout called `vm.kill`, which triggered supervisor `onFatal` auto-restart; terminated tenants could resurrect and replay programs/FFI. | `ProcessTenantRuntime.terminate()` sets `terminating`, stops auto-restart, waits for restart, then kills; timeout paths stop auto-restart before closing. Covered by `TenantManager ... terminate does not resurrect`. |
| S2 | MEDIUM | Command timeout left tenant `ready` while VM was dead. | Active timeout marks the runtime crashed and closes it; queued timeout rejects only that pending. |
| S3 | MEDIUM | `manager.restart` wedged on in-flight calls; loader `restart` could throw `E-VM-BUSY` and leave the runtime closed. | Restart is awaited/serialized; failed restart marks crashed and stops auto-restart. |
| S4 | MEDIUM | RSS sampler had no timeout, overlap guard, or incarnation binding; slow PowerShell samples could kill a new child. | Windows sampler has 2s timeout/SIGKILL; `sampleRss()` guards overlap and re-checks child/pid after await. |
| S5 | MEDIUM | Non-Linux/Win32 silently had no RSS supervision; tenant manager dropped restart events. | Platform limitation documented; `TenantManager` now exposes `onEvent` and emits resource/restart events. |
| S6 | MEDIUM | Resource config was unvalidated; zero thresholds could cause kill/restart loops. | `validateResource()` rejects unsafe limits with `E-RESOURCE-CONFIG`; `rssSampleMs:0` is explicitly allowed only for tests. |
| S7 | MEDIUM | Manager `commandTimeout` did not cover queued commands. | Queued deadlines are enforced by `ProcessTenantRuntime` and reject with `E-TENANT-TIMEOUT`. |
| S8 | LOW | Child inherited all environment variables; docs drift; heartbeat `active` unused; missing tests. | Documented as residual; new supervision tests added. Environment filtering is not in this candidate. |

## Code findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| C1 | HIGH | `ProcessTenantRuntime._run` returned a synchronous `programResult`; `_drain` called `.then` on it and wedged the active slot. | `_run` is async; `programResult` is awaited. Regression test added. |
| C2 | MEDIUM | Queued timeout could be lost; restart failure wedged; backoff reset after success; events dropped; process `openTimeout` was a no-op; terminate raced restart. | Queued deadline rejects the pending; failed restart marks crashed and stops auto-restart; backoff is based on the 10-minute window; manager events emitted; real open timeout; terminate waits/serializes. |
| C3 | LOW | Stale RSS samples; resource config unvalidated; benchmark counted errors repeatedly; docs counts stale. | Incarnation check, config validation, `errorsByCode` aggregation, docs counts updated. |

## Release findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| R1 | HIGH | 1h evidence was not reproducible / not bound to a tree. | Raw 120-window JSONL, analyzer summary, environment, command, commit, engine and registry hashes are tracked under `docs/evidence/`. |
| R2 | MEDIUM | Heartbeat could kill a busy synchronous call; docs presented it as hang detection. | Active calls no longer accumulate heartbeat misses; per-request timeout remains the hang control. |
| R3 | MEDIUM | TENANT counts were stale; review record bound an old tree; PACKAGING claimed Linux full suite. | Counts updated to 401/400/1 and selfcheck 112; review bound to this record; Linux labelled 10min smoke. |
| R4 | MEDIUM | TENANT claimed review complete while pending; referenced review did not cover 0.22. | This record covers 0.22 and stays CONDITIONAL until fix-verification. |
| R5 | MEDIUM | Missing tests for heartbeat kill, Wasm threshold, Windows sampler, openTimeout, terminate/auto-restart. | Added resource validation, active heartbeat, auto-restart, restart-limit, terminate and programResult tests. |
| R6 | LOW | open timeout no-op; terminate auto-restart; overlapping Linux windows; stale platform text. | Fixed; Linux evidence explicitly pre-fix. |

## Verification evidence

- Full suite: 401 tests / 400 pass / 1 skip / 0 fail (`82ab855`).
- selfcheck: 112 release files.
- Windows 1h supervised mixed `final4`: **FAILED** criterion 3 and 4.
  2,280,907 calls, 0 errors, 0 restarts, p95 0.985×, p99 0.981×, but the last
  9 minutes rose monotonically from 57.1MB to 82.9MB and every runtime's
  post-GC RSS was above its pre-GC value. See
  `docs/evidence/os-supervision-1h-2026-11-14-final4.md`.
- Verdict: **NO-GO**; do not tag or publish. Per plan §7.1, no automatic re-run.
- Linux 10min: 600s, 1,162,307 calls, 0 errors, 0 restarts, p95 1.023×,
  RSS +3.785 MiB/min; pre-fix tree, labelled as such.

## Residual conditions

- No macOS verification; platform support is documented, not universal.
- RSS supervision is sampled, not an OS Job Object hard cap.
- FFI provider termination may leave external side effects.
- Linux final-tree 10min rerun was not possible in this environment.
- Final independent fix-verification verdict is still pending.
