# Chez Wasm remediation tracker (F1–F8)

Status: version 0.19.0; F1–F8 code-level remediation complete and independently confirmed experimental PASS.
The opt-in v2 production seam and blocking FFI transport are implemented and security-hardened, but v2 is
not connected to the default pin/CLI and is not a release approval. P3 OS supervision, P4 release
closure and P6 monitoring remain open.
The aggregate result is mixed by design: 24 current C ABI tests + 2 retained coverage suites on legacy
assets. This tracker executes the code-level remediation from
`../reviews/chez-production-readiness-2026-11-09/production-readiness-report.md`.
It does not approve production use or alter v1 defaults.

## P0 baseline

- [x] Baseline recorded. The P1 work is confined to `experiments/`; the P2/P3 work adds
  `lib/rules/scheme/v2/`, packaged assets, release checks and tests. Production default remains
  v1, and publication remains unapproved.
- [x] Report F1–F8 and P0–P7 reviewed against the implementation.
- [x] Independent re-review after F1–F8 fixes: final reviewer confirms F1–F8 experimental PASS; mixed-asset boundary of the 26-test aggregate recorded and corrected in the runner/report.
- [x] P0 charter approved for implementation: `../reviews/chez-production-readiness-2026-11-09/PHASE6-CHARTER.md`. No enterprise owner roles or human signatures are required; technical acceptance is by independent subagents. Publication remains unapproved and Q1–Q12 are still open.
- [x] Project owner authorized P2–P4/P6 implementation (2026-11-09). P5 migration and P7 release remain human gates.

## P1 code and evidence

| ID | Finding | Fix target | Status |
|---|---|---|---|
| F1 | Bundle installation can leave partial registry/global library state | fail-closed own registry + poisoned VM; host must destroy incarnation | PASS (experimental) — `PluginRuntime` restarts and replays on failed bundle; global-library leak cleared; `test-plugin-runtime.mjs` 4/4 |
| F2 | Engine closure is not tied to the exact assets the Worker executes | required closure set, duplicate/extra rejection, path containment, ABI manifest parse, data archive inventory | PASS (experimental, archive inventory scope) — 13/13 negative cases; ABI manifest and data archive hashes validated; boot provenance remains P3 |
| F3 | `bundleHash` omits module version and normalized project import edges; plugin-side and pin-side encoders differ | canonical `{name, version, treeHash, imports}` bundle record shared by both sides | PASS (experimental) — `test-cross-side-bundle.mjs` compares pin-side and plugin-side hashes for the same two-module bundle with a non-empty `only` project import; pin and plugin use separate normalization functions; `test-pin-v2.mjs` covers kind/name/version negatives; `test-pin-load-imports.mjs` declares a valid rule and rejects a module importing that rule library, so the old rule-inclusive allowlist would reach `E-PIN-MISMATCH-BUNDLE`; 3/3 bundle hash; pin A/B distinct |
| F4 | Timeout resumes the same incarnation and late replies are not audited | terminate/destroy incarnation on timeout/cancel; late-completion audit; requestId tombstones | PASS (experimental) — real C ABI `ffi-call` abort integration; worker terminated, new incarnation serves; tombstone/late audit pass |
| F5 | `/project` guard authorizes before path normalization | normalize and contain paths before every mount/open/rename check; deny links | PASS (experimental write-containment scope) — memfs/quota/links/rename pass; read visibility is the mounted allowlist, not cross-root denial; vacuous secret/traversal read assertions removed; `FS.link` is not implemented |
| F6 | Tab-delimited FFI frames are injectable | strict JSON frames, full escaping, finite numbers, schema, byte-length cap | PASS (experimental frame scope) — C0/non-finite/injection/65536-byte cap (including 80,000-byte multibyte frame) pass; production host wiring remains P2 |
| F7 | Async rejection bypasses stable FFI errors; ABI types are loose | awaited async handlers, stable `E-FFI-HOST`, declared scalar/return types | PASS (experimental) — async rejection, non-finite args, and return-type negative pass |
| F8 | C ABI slices output without a max-output/HEAP bound | C output cap + Worker bounds/max check + negative test | PASS (experimental) — `E-OUTPUT-LIMIT`, incarnation exit 70; worker code preserved |

## Evidence policy

Every row is complete only when the relevant regression passes after the final
asset rebuild. Results must be written under `../results/chez/10.4.1-c/` and the
engine registry/fixtures refreshed together. A scoped experimental PASS is not a
production approval.

## Final regression (2026-11-09)

Runner: `node experiments/wasm/chez/run-remediation-regressions.mjs` with the bundled Node 24 runtime.
Result: **26/26 PASS**, `ok=true`, written to
`experiments/wasm/results/chez/10.4.1-c/remediation-regressions.json`.
This is 24 current C ABI tests plus 2 retained coverage suites that read legacy `10.4.1` assets
(`run-plugin-isolation.mjs`, `run-corpus-v2.mjs`); see the runner's `boundary` field.

The runner excludes four non-current artefacts explicitly: `test-host-bridge.mjs` (legacy
Worker/SAB + libffi), `test-host-capabilities.mjs` (legacy two-phase protocol),
`test-suspend-c.mjs` (rejected continuation resume), and `test-script-output.mjs`
(argument-required helper, not a standalone test).

Final assets: js `16eda1e853ad1d2a27bea0439091af972f8b6c38bbc9fa5f98df643918ad6659`,
wasm `b0aa6503c7642f3b09da229569b1cc5f9ff8ec8e01b18fb5a57b90ab5e6deceb`,
data `3b6aa297ed779a697e1a71369622ed42c1bd8e73fec7542ff02d3268b54a4692`.
Final engine: `sha256:2e6b45625af308c7452e80273a0539b7a7dd52f2c261c0e56505f90bd211f826`.
Raw results are under `experiments/wasm/results/chez/10.4.1-c/`; the current
runner output is `remediation-regressions.json` with 26/26 PASS.

## Independent review record

- Final reviewer (`omdd-mw8n4em2-j`, 2026-11-09) read the F1–F8 implementation, reran key hashes,
  confirmed all eight experimental PASS, found no open HIGH/MEDIUM code issue, and accepted the
  `test-pin-load-imports.mjs` discriminator. It flagged one evidence-boundary issue: the 26-test
  aggregate includes two legacy-asset suites. That boundary is now recorded in the runner and report.
- This is a code/evidence review, not a production approval or a substitute for P5/P7 human gates.

## Still open

- P2 production adapter is implemented as an explicit opt-in API: `loadSchemeV2Pin` verifies a v2 pin against the packaged engine and `SchemeV2Runtime` executes verified rules in a long-lived C-ABI VM. Rules may import `(dsh ffi (6))` and call only pin-declared, host-allowlisted targets; `plugins` execution is rejected with `E-V2-PLUGIN-UNSUPPORTED`. It is not yet connected to the default pin loader/CLI.
- P3 host bridge transport is implemented for the opt-in runtime: `CvmClient` services strict `DSH-FFI` JSON frames through shared ring buffers, rejects malformed/unauthenticated/duplicate frames, maps host failures to `E-FFI-HOST`, and kills the incarnation on timeout. A per-VM host token and host-bound rule hash are required on every frame; verified rules cannot import `(chezscheme)` or reach the interaction environment, so they cannot read the token or forge another rule identity. `pin.ffi=[]` plus a host provider is rejected as `E-V2-FFI-UNDECLARED`; `(exit n)` maps to `E-VM-EXIT`. Rule-level FFI is exercised end to end (`test/scheme-v2-pin.test.js` 17/17); production suite is 335 pass / 1 skipped. The full late/drop/cancel/nested/host-crash matrix and an independent OS supervisor (process/cgroup/Job Object resource limits, restart) are not implemented.
- P4 preparation: `scripts/selfcheck.mjs` avoids UTF-8 decoding for binary extensions, checks `.wasm` magic, and requires `assets/SHA256SUMS` entries for shipped binaries. The helper is `scripts/selfcheck-lib.mjs` with unit tests `test/selfcheck-lib.test.js` (3/3). The v2 engine assets are now in `assets/chez-wasm/10.4.1-c/`, with checksums and engine registry; `node scripts/selfcheck.mjs` passes 88 shipped files. This is still not a complete release closure: SBOM, license notices, cross-platform verification and reproducible boot provenance remain open. Identical rebuilds produced different `scheme-c.js` hashes while `.wasm`/`.data` stayed stable (observed `ef0effe6…`, `578cd341…`, `dafc91a0…`, `16eda1e8…`), so the JS glue is not yet byte-reproducible and must be resolved before release.
- Production default remains v1; v2 is opt-in only. Production cutover, real v1→v2 migration, packaging approval, licensing, cross-platform and canary work remain NO-GO.

## Production v2 artifact snapshot (2026-11-09)

- Engine contract: `chez-wasm-c-10.4.1-v1`; `engineArtifactHash`: `sha256:2e6b45625af308c7452e80273a0539b7a7dd52f2c261c0e56505f90bd211f826`.
- Shipped assets: js `16eda1e853ad1d2a27bea0439091af972f8b6c38bbc9fa5f98df643918ad6659`, wasm `b0aa6503c7642f3b09da229569b1cc5f9ff8ec8e01b18fb5a57b90ab5e6deceb`, data `3b6aa297ed779a697e1a71369622ed42c1bd8e73fec7542ff02d3268b54a4692`.
- Verification: `node --test test/*.test.js` → **335 pass / 1 skipped**; `node scripts/selfcheck.mjs` → **OK (88 files)**; `test/scheme-v2-pin.test.js` → **17/17**.

## Human gates

P5 migration pilot and P7 production release require explicit human approval.
