# Version and platform matrix

The word “v2” appears on several independent axes. They are not the same
contract and do not move together.

| Axis | Current value | Where it lives | Meaning |
| --- | --- | --- | --- |
| Curation pin | `5` | `lib/pin.js` `PIN_VERSION` | v5 pin shape used by `curation_pin` |
| Contract | `4` | `lib/contract.js` `CONTRACT_VERSION` | table field/normalization/evidence contract |
| State DB schema | `6` | `lib/db.js` `STATE_SCHEMA_VERSION` | `.curation/project.sqlite` migrations |
| Scheme runtime | `v2` | `dsh-pin/v2` | explicit opt-in `SchemeV2Runtime` pin |
| Package | `0.23.0` | `package.json` | npm/tarball version, independent of the four contracts |

A “v1” pin-rule DSL is the optional `pin.rules` block in v5, not an older pin
schema. A `dsh-pin/v2` pin is a separate opt-in format and is never migrated
from v5 automatically.

## Platform support

- Supported: Node.js 24 or newer. The package no longer restricts `os`/`cpu`.
- Tested: Windows x64 and Linux x64 (Node 24).
- Experimental: macOS and other Node-24 platforms; the Wasm engine has no
  native addon or Win32-only API, but the 1-hour evidence is Windows-only.
- The runtime refuses only an old Node version (`E-UNSUPPORTED-PLATFORM`).

`engines.node` is a declaration for package managers; the runtime check is the
authoritative guard.
