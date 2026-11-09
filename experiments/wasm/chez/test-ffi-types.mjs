import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFfiRegistry, FfiError, validateFfiManifest } from './ffi-registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(HERE, 'ffi-manifest.json'), 'utf8'))

function expectCode (fn, code) {
  try {
    fn()
  } catch (error) {
    if (error instanceof FfiError && error.code === code) return
    throw new Error(`expected ${code}, got ${error.code || error.message}`)
  }
  throw new Error(`expected ${code}, no error`)
}

validateFfiManifest(manifest)
const ffi = createFfiRegistry({
  manifest,
  handlers: {
    'math.add': ([a, b]) => a + b,
    'math.fail': () => { throw new FfiError('E-FFI-HOST', 'host rejected') },
    'delay.echo': ([value]) => Promise.resolve(value),
    'delay.slow': () => new Promise(() => {}),
  },
})

const value = ffi.call({ module: 'math', function: 'add', args: [2, 3] })
if (value !== 5) throw new Error(`unexpected value: ${value}`)
expectCode(() => ffi.call({ module: 'math', function: 'add', args: ['2', 3] }), 'E-FFI-TYPE')
expectCode(() => ffi.call({ module: 'delay', function: 'echo', args: [42] }), 'E-FFI-TYPE')
expectCode(() => ffi.call({ module: 'math', function: 'add', args: [Number.NaN, 3] }), 'E-FFI-TYPE')
expectCode(() => ffi.call({ module: 'math', function: 'add', args: [Number.POSITIVE_INFINITY, 3] }), 'E-FFI-TYPE')

const invalid = structuredClone(manifest)
delete invalid.modules.math.functions.add.args
expectCode(() => validateFfiManifest(invalid), 'E-FFI-MANIFEST')

const badReturn = createFfiRegistry({
  manifest,
  handlers: {
    'math.add': () => 'not-a-number',
    'math.fail': () => undefined,
    'delay.echo': ([value]) => Promise.resolve(value),
    'delay.slow': () => Promise.resolve('ok'),
  },
})
expectCode(() => badReturn.call({ module: 'math', function: 'add', args: [2, 3] }), 'E-FFI-TYPE')

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  cases: ['manifest-types-required', 'number-arg-type', 'string-arg-type', 'sync-value', 'return-type'],
}, null, 2))
