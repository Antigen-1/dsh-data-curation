import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET = join(HERE, '10.4.1-c')

function loadModule() {
  const code = readFileSync(join(ASSET, 'scheme-c.js'), 'utf8')
    .replace(/^var Module=/, 'var Module=globalThis.__dshModule; var __wasmModuleOriginal=')
  const errors = []
  globalThis.__dshModule = {
    locateFile: (file) => join(ASSET, file),
    wasmBinary: readFileSync(join(ASSET, 'scheme-c.wasm')),
    printErr: (line) => errors.push(String(line)),
    print: () => {},
    quit: (status, toThrow) => { throw toThrow },
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('init timeout')), 30000)
    globalThis.__dshModule.onRuntimeInitialized = () => {
      clearTimeout(timer)
      resolve({ module: globalThis.__dshModule, errors })
    }
    const factory = new Function('require', '__dirname', '__filename', 'process', 'Buffer', 'setTimeout', 'clearTimeout', code)
    try {
      factory(require, HERE, join(ASSET, 'scheme-c.js'), process, Buffer, setTimeout, clearTimeout)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}

function cstring(module, text, fn) {
  const bytes = Buffer.from(text + '\0', 'utf8')
  const ptr = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, ptr)
  try {
    return fn(ptr)
  } finally {
    module._free(ptr)
  }
}

function call(module, name, payload) {
  const bytes = Buffer.from(payload, 'utf8')
  const ptr = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, ptr)
  const rc = module[`_${name}`](ptr, bytes.length)
  module._free(ptr)
  if (rc !== 0) throw new Error(`${name} rc=${rc}`)
  const outPtr = module._dsh_out_ptr()
  const outLen = module._dsh_out_len()
  return Buffer.from(module.HEAPU8.slice(outPtr, outPtr + outLen)).toString('utf8')
}

const { module, errors } = await loadModule()
console.error('loaded')
cstring(module, '/suspend-probe.scm', (ptr) => {
  const rc = module._dsh_set_guest(ptr)
  if (rc !== 0) throw new Error(`set_guest rc=${rc}`)
})
console.error('guest set')
const initRc = module._dsh_init()
console.error('init', initRc)
if (initRc !== 0) throw new Error(`dsh_init rc=${initRc}`)

const suspended = call(module, 'dsh_dispatch', 'suspend')
console.error('suspended', suspended)
const final = call(module, 'dsh_resume', 'hello')
console.error('final', final)
const noPending = call(module, 'dsh_resume', 'again')
const result = { suspended, final, noPending, errors }
console.log(JSON.stringify(result, null, 2))
if (suspended !== 'suspended' || final !== 'final:hello' || noPending !== 'no-pending') process.exit(1)
