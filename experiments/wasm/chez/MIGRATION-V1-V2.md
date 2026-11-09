# v1 → v2 pin migration (experimental)

v1 pins stay read-only. This document and `migrate-v1-v2.mjs` produce a report for human review; they never rewrite a pin or silently convert an AST rule.

## 1. Why a report is required

v1 stores a JSON AST as the rule identity. v2 stores Scheme source bytes, a datum tree hash, a project bundle hash, a plugin-environment hash, an FFI-environment hash and a rule hash. The two identities are not interchangeable:

- a v1 AST has no `sourceBase64`;
- canonical v1 AST and Scheme datum have different encodings;
- v1 has no project-plugin or FFI environment aggregate;
- a v2 rule needs an explicitly approved engine contract.

The report lists those differences per rule. A human must supply or approve the Scheme source and the plugin/FFI environment before a v2 entry is created.

## 2. Report generator

```bash
node experiments/wasm/chez/migrate-v1-v2.mjs <v1-pin-rules.json> <report.json>
```

Input may be a v1 `{ "rules": [...] }`, a map of rule names to rule objects, or an array of rule objects. Output is an array of entries:

```json
{
  "name": "example.merge",
  "id": "example.merge",
  "version": "1",
  "v1SourceKind": "ast",
  "v2Status": "manual-confirmation-required",
  "blockers": [
    "v1-ast-is-not-scheme-source",
    "signature-needs-human-mapping",
    "plugin-environment-unresolved",
    "ffi-environment-unresolved"
  ],
  "v1Hash": null,
  "v2Hashes": null,
  "requiresHumanConfirmation": true
}
```

A rule that already contains `sourceBase64` is still marked `manual-confirmation-required`; the generator does not assert that the source is semantically equivalent. A report entry with `blockers: []` only means no structural blocker was detected, not that migration is approved.

## 3. Human migration procedure

1. Freeze the v1 pin; do not edit it in place.
2. For each rule, recover the exact Scheme source and record it as UTF-8 bytes.
3. Compute `treeHash` in the approved v2 VM; compare the rule's observable behavior with v1 fixtures.
4. Declare the project modules that form the bundle; compute `bundleHash`.
5. Declare the plugin and FFI environments; compute their hashes.
6. Build a candidate v2 pin, run `test-pin-v2.mjs`-style validation, and attach the report plus behavior diff.
7. A human signs off each rule. No batch conversion and no automatic default switch.
8. Keep the v1 pin available read-only until the migration pilot is accepted.

## 4. Explicit non-actions

- This phase does not change `lib/pin-rules.js`, `PIN_RULES_VERSION`, or the production default.
- It does not add a v1 AST → Scheme source converter.
- It does not claim that equal observable behavior implies equal identity.
- It does not make v2 the default for new projects.
