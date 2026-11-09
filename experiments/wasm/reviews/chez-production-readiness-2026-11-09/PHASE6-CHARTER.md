# Phase 6 charter — Chez/Wasm source-native v2

**Status:** APPROVED FOR IMPLEMENTATION (2026-11-09). This charter authorizes
productionization work in this repository. It does not authorize npm publish,
a release tag, or a production canary.

**Date:** 2026-11-09  
**Baseline:** `v0.18.0`, commit `a0d5a4d082539460a3d841764c28b6b8043567dc`  
**Related:** [production readiness report](production-readiness-report.md),
[remediation tracker](../../chez/REMEDIATION-TRACKER.md),
[evidence ledger](../../chez/EVIDENCE-LEDGER.md).

## 1. Decision

Implementation is approved by the project owner (2026-11-09). The project is
pre-1.0 and does not require enterprise-style named owners or sign-off roles.

Fixed properties:

- v1 rule language, `PIN_RULES_VERSION=1`, and existing pins remain the default.
- v2 is explicit opt-in only; no automatic migration, no silent fallback.
- The first production shape is trusted, single-tenant, and source-native.
- No npm publish, release tag, or canary before Q0–Q12 pass.
- P5 migration and P7 release remain human gates.

**Current decision:** implement P2–P4/P6 and remove the known security gaps;
publication is still not approved.

## 2. Scope

In scope after separate approval:

1. A production adapter for v2 pin loading and explicit opt-in execution.
2. An OS-supervised runtime, not only a Node Worker.
3. Production packaging, binary selfcheck, SBOM/NOTICE, and platform claims.
4. Monitoring, capacity, and canary runbooks.
5. A single-tenant trusted-project security model.

Out of scope:

- Multi-tenant isolation.
- Removing or rewriting v1 pins.
- Automatic AST→Scheme migration.
- Cross-platform support claims without evidence.
- Production release in this charter.

## 3. Accountability and review

No enterprise owner roles or human signatures are required. The project owner
authorizes implementation; technical acceptance is performed by independent
subagents, and their findings are recorded with evidence paths.

| Boundary | Independent review |
|---|---|
| P2 production seam | code-reviewer subagent, fresh context |
| P3 supervisor / FFI | security-reviewer + runtime reviewer subagents |
| P4 package closure | dependency/release reviewer subagent |
| Final P5/P7 decision | human project owner; independent verifier evidence attached |

A review is not a release approval. An unowned review is a gap, not an implicit
approval.

## 4. Gates

The gate definitions are in the [production readiness report](production-readiness-report.md).
The current states are:

| Gate | Current | Blocking condition |
|---|---|---|
| Q0 scope/approval | PASS | implementation approved; publication not approved |
| Q1 correctness/identity | FAIL (production) | F1–F8 are experimental PASS; no production candidate |
| Q2 production seam | FAIL | v2 is not wired into the production CLI/package |
| Q3 OS supervision/OOM | FAIL | no OS supervisor or C-ABI OOM evidence |
| Q4 final blocking FFI | FAIL | rule-level FFI works, but no final-engine late/drop/cancel/host-crash matrix |
| Q5 pin/plugin/FFI security | FAIL | FFI allowlist and rule bindings work; non-empty plugins and live plugin registry still open |
| Q6 package/selfcheck | PARTIAL | binary-aware selfcheck present; packed closure absent |
| Q7 license/reproducible build | FAIL | SBOM/NOTICE and clean rebuilds absent |
| Q8 platform support | FAIL | only win32-x64 experimental evidence |
| Q9 migration/rollback | FAIL | no human pilot |
| Q10 monitoring/canary | FAIL | no production metrics or canary thresholds |
| Q11 capacity | FAIL | only cold-start samples |
| Q12 v1 compatibility | PENDING | must be checked against the candidate |

Q0–Q12 are conjunctive. A scoped experimental PASS never substitutes for a
production gate.

## 5. Work packages

| Package | Entry | Deliverable | Exit |
|---|---|---|---|
| P0 charter | report delivered | this charter; ADR/blocking/support notes; review plan | implementation approval; technical gates tracked |
| P1 code remediation | P0 | F1–F8 fixes and evidence | final independent review; **done as experimental PASS** |
| P2 production candidate | P0/P1 approval | opt-in adapter, v1 default, real CLI compare/apply/verify | Q2/Q5/Q12 pass on candidate commit |
| P3 OS/FFI boundary | P2 | OS supervisor, OOM/fault matrix, final blocking bridge | Q3/Q4 pass |
| P4 release artifacts | P1/P2 | binary selfcheck, pack closure, SBOM/NOTICE, platform matrix | Q6–Q8 pass |
| P5 migration pilot | P2/P3 | human-approved migration and v1 rollback drill | Q9 pass |
| P6 monitoring/capacity | P3/P4 | metrics, alerts, soak/capacity, canary abort/runbook | Q10/Q11 pass |
| P7 final review/release | P0–P6 | independent sign-off | human release decision |

P5 and P7 require explicit human approval and are not automated by this charter.

## 6. Blocking-model contract

The current experimental profile is **blocking host bridge**:

- Guest blocks inside one `dsh_dispatch` call while the host fulfills an FFI request.
- The host terminates the whole incarnation on timeout/cancel.
- Late settlements are audited and never resume the old incarnation.
- Continuation resume across `dsh_dispatch` is not part of this profile.

The historical two-phase asyncify contract is superseded for this profile and
must not be cited as production evidence. A future continuation design requires
a new ADR and a new security review.

## 7. Support statement

Until Q8 passes, the only supported experimental cell is:

- Windows x64, bundled Node 24 runtime, the exact assets and engine hash in the
  evidence ledger.

Any other OS/CPU/Node combination is unsupported. This is a claim limitation,
not a platform commitment.

## 8. Change control

- The charter, gate table, and engine hash must be versioned together.
- Any engine rebuild invalidates downstream evidence until hashes and fixtures
  are refreshed.
- Any new HIGH/CRITICAL finding returns the program to NO-GO.
- Changes to `lib/`, package contents, pin defaults, or release metadata require
  tests plus an independent subagent review recorded with an evidence path.
- npm publish, release tags, and canaries remain outside this charter.

## 9. Evidence index

- [Production readiness report](production-readiness-report.md)
- [Remediation tracker](../../chez/REMEDIATION-TRACKER.md)
- [Evidence ledger](../../chez/EVIDENCE-LEDGER.md)
- [Pin v2 contract](../../chez/PIN-V2.md)
- [Source-tree contract](../../chez/SOURCE-TREE.md)
- [Migration contract](../../chez/MIGRATION-V1-V2.md)

## 10. Approval block

- Implementation approved by project owner: **2026-11-09**
- Instruction: allow productionization; no enterprise owner roles; acceptance
  and review may be delegated to independent subagents.
- Publication approval: **NOT GRANTED**.
- P5 migration and P7 release: **human decision required**.

This approval starts P2–P4/P6 implementation. It does not authorize npm publish,
a release tag, or a production canary.
