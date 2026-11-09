# Pin v2 experimental contract

Status: experimental Phase 5 contract. It does not change the production default pin version.

## 1. Rule entry

A v2 rule is a source-level identity. `sourceBase64` carries exact UTF-8 bytes; it is not a hash input. The loader decodes the bytes strictly, rejects invalid UTF-8 and NUL, then lets Chez `read` build the datum and the datum validator reject unsupported or unbounded structures.

```json
{
  "id": "rule.example",
  "version": "1.0.0",
  "sourceEncoding": "utf-8-base64",
  "sourceBase64": "...",
  "treeHash": "sha256:...",
  "bundleHash": "sha256:...",
  "signature": { "inputs": [], "output": "boolean", "variadic": false },
  "pluginEnvironmentHash": "sha256:...",
  "ffiEnvironmentHash": "sha256:...",
  "ruleHash": "sha256:..."
}
```

`treeHash` is `SHA-256("dsh/source-tree/v2\0" || canonicalTree)`. `sourceBytesHash` is intentionally absent; comments, whitespace, quote/radix spelling and other lexical differences do not create a different rule identity.

## 2. Pin document

```json
{
  "schema": "dsh-pin/v2",
  "project": "example",
  "engine": {
    "contract": "chez-wasm-c-10.4.1-v1",
    "engineArtifactHash": "sha256:..."
  },
  "modules": [
    { "name": "(dsh lib math v1)", "version": "v1", "sourceBase64": "..." }
  ],
  "plugins": [],
  "ffi": [],
  "rules": [ { "...": "rule entry" } ]
}
```

`modules` are the project libraries in the rule's bundle. Only four-element
`(dsh plugin <name> <version>)` and `(dsh lib <name> <version>)` library names are
accepted. The plugin loader rejects other names with `E-LIBRARY-NAME`; the pin
verifier rejects them with `E-PIN-MODULE-KIND`. The `version` field must equal the
last element of the printed name (`version == last(name)`); it is retained as an
explicit hash input but is not independently variable. Their sources feed
`bundleHash`:

```text
bundleHash = SHA-256("dsh/source-bundle/v2\0" ||
  emit-datum(bundle
    (module name version treeHash imports) ...))   ; sorted by printed name
```

`name` is the printed library name string, `version` is the version symbol string,
`treeHash` is the source tree hash, and `imports` is the sorted unique list of
normalized project-library import names after stripping `only`/`except`/`prefix`/
`rename`/`for`. The plugin loader and the pin verifier use this exact record and
the same `emit-datum` encoder; the C ABI exposes a cross-check via
`plugin-pin-bundle`.

`plugins` and `ffi` are canonical descriptor lists. Empty lists are hashed as empty domains, never as a missing field. `ruleHash` binds the rule identity to the bundle and environments:

```text
ruleHash = SHA-256("dsh/rule/v2\0" || canonical(
  rule id version treeHash bundleHash signature
       pluginEnvironmentHash ffiEnvironmentHash))
```

## 3. Trusted engine registry

The host owns `engine-registry.json`; a pin never supplies an engine path. The registry maps an approved `engine.contract` to:

- `assetsDir` (host-controlled path);
- a closure list of `{path, sha256, size}`;
- `engineArtifactHash = sha256:hex(SHA-256(canonical({contract, files, dataArchive})))`.

The loader verifies every closure file before starting the Wasm VM. `online-vm-abi.json` is part of the closure, so an ABI or export-set change changes the engine identity. The pin's `engine.engineArtifactHash` must equal the registry value. A different contract is rejected as `E-ENGINE-NOT-APPROVED`; a changed file is rejected as `E-ENGINE-HASH`; a changed closure manifest is rejected as `E-ENGINE-MANIFEST-HASH`.

## 4. Load order

1. Validate pin schema and engine fields.
2. Verify the registry closure and engine artifact hash.
3. Strictly decode every rule/module source.
4. Start a non-authoritative C-ABI VM with the verified assets.
5. Recompute `treeHash`, `bundleHash`, plugin/FFI environment hashes and `ruleHash` in the VM.
6. Compare every field; on any mismatch, close the VM and publish nothing.
7. Send one `pin-load` request: the VM parses every rule/project library, rejects duplicate library names or an import graph that does not close over the declared modules/standard libraries, recomputes all hashes again, and only then replaces its in-memory metadata registry.
8. Only after `pin-load` reports `loaded=true` and `registry` equal to the rule count, return the verified descriptors. Project code is not executed by this loader.

The loader is deliberately fail-closed: it does not mutate a live registry or retain a partially verified rule. A caller may execute project code only after a successful `loadPinV2` result. The `pin-load` registry contains rule metadata only (id, version, parsed library name, tree hash, expected bundle hash, rule hash); it does not publish module descriptors, capabilities, or FFI runtime bindings.

## 5. Experimental evidence

- `pin-v2-loader.mjs` — loader.
- `pin-v2-lib.mjs` — strict base64/UTF-8, canonical JSON, engine verification.
- `make-pin-v2-fixtures.mjs` — fixture/registry generator; run this first.
- `refresh-engine.mjs` — recomputes the data archive and final engine hash; run this second.
- `test-pin-v2.mjs` — fresh/repeat, A/B, tree-hash tamper, version/name mismatch, invalid UTF-8, unapproved engine, registry closure tamper, rollback.
- `test-cross-side-bundle.mjs` — compares the pin-side and plugin-side bundle hash for the same module source.
- `test-pin-load-imports.mjs` — declares a rule and rejects a module that imports that rule library.
- `test-bundle-hash.mjs` — repeat/import-edge/version sensitivity of the pin-side bundle hash.
- `engine-registry.json`, `pin-v2-fixtures/pin-v2-a.json`, `pin-v2-fixtures/pin-v2-b.json`.
- Result: `experiments/wasm/results/chez/10.4.1-c/pin-v2.json`.

After a C asset rebuild, run `make-pin-v2-fixtures.mjs` first and `refresh-engine.mjs`
second; running the fixture generator alone leaves the engine hash without the
data-archive binding and the verifier rejects it.

## 6. Limits

This document describes the experimental v2 pin contract: metadata import-graph
closure, atomic metadata publication and tamper behavior. Production now has a
separate opt-in runtime (`loadSchemeV2Pin` / `SchemeV2Runtime`) that verifies the
same hash contract before executing verified rules in a long-lived C ABI VM.
v2 is still not the default, `lib/pin-rules.js` still defaults to v1, and
publication, migration and the human migration pilot remain unapproved.
