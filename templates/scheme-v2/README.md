# Scheme v2 / advanced examples

These files are examples only; they are not imported by the runtime.

- `pin-builder.mjs` — build a `dsh-pin/v2` object with the public builder.
- `multitable-pin.json` — two-table v5 pin with shared defaults and per-table gates. Add `verifyCmd` only after shipping a project-specific check script; the example intentionally omits it.
- `rules-source.scm` — v1 pin-rule DSL source for `curation_pin({ rulesSource })`.

For runtime plugins, create a project root with:

```text
rules/scheme/lib/dsh/plugin/<id>/<version>.sls
rules/scheme/programs/*.scm
```

Then build the pin with `buildSchemeV2Pin({ plugins: [...] })` and open it with
`SchemeV2Runtime.open(pin, { projectRoot, ffiModules })`.
