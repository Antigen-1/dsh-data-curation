// Build a dsh-pin/v2 pin without copying test helpers.
// Run from the project root after installing this package.
import { buildSchemeV2Pin, hashSchemeSource } from 'dsh-data-curation/rules'

const ruleSource = `(library (dsh rule rule.example (1 0 0))
  (export entry)
  (import (rnrs base (6)))
  (define (entry x) (* x 2)))`

const pin = await buildSchemeV2Pin({
  project: { name: 'example' },
  rules: [{ id: 'rule.example', version: [1, 0, 0], source: ruleSource }],
  modules: [],
  plugins: [],
  ffi: [],
})

console.log(await hashSchemeSource(ruleSource))
console.log(JSON.stringify(pin, null, 2))

// FFI pins additionally pass ffiModules at open time:
// {
//   ffi: [{ id: 'math.add', subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }] }],
// }
// const runtime = await SchemeV2Runtime.open(pin, {
//   projectRoot: process.cwd(),
//   ffiModules: { math: new URL('./ffi/math.mjs', import.meta.url).href },
// })
