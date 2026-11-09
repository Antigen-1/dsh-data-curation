import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(HERE, '10.4.1-c')
const RESULT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')
const OUT = join(RESULT_DIR, 'online-vm-c.json')

function loadModule() {
  const js = readFileSync(join(ASSET_DIR, 'scheme-c.js'), 'utf8')
  const code = js.replace(
    /^var Module=/,
    'var Module=globalThis.__dshModule; var __wasmModuleOriginal=',
  )
  const stderr = []
  globalThis.__dshModule = {
    locateFile: (path) => join(ASSET_DIR, path),
    wasmBinary: readFileSync(join(ASSET_DIR, 'scheme-c.wasm')),
    printErr: (line) => stderr.push(String(line)),
    print: () => {},
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('module init timeout')), 30000)
    globalThis.__dshModule.onRuntimeInitialized = () => {
      clearTimeout(timer)
      resolve({ module: globalThis.__dshModule, stderr })
    }
    try {
      const factory = new Function(
        'require',
        '__dirname',
        '__filename',
        'process',
        'Buffer',
        'setTimeout',
        'clearTimeout',
        code,
      )
      factory(require, HERE, join(HERE, 'scheme-c.js'), process, Buffer, setTimeout, clearTimeout)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}

function dispatch(module, payload) {
  const bytes = Buffer.from(payload, 'utf8')
  const ptr = module._malloc(bytes.length)
  if (!ptr) throw new Error('malloc failed')
  module.HEAPU8.set(bytes, ptr)
  const rc = module._dsh_dispatch(ptr, bytes.length)
  module._free(ptr)
  if (rc !== 0) throw new Error(`dsh_dispatch rc=${rc}`)
  const outPtr = module._dsh_out_ptr()
  const outLen = module._dsh_out_len()
  if (outPtr === 0 || outLen < 0) throw new Error(`bad output ptr=${outPtr} len=${outLen}`)
  return Buffer.from(module.HEAPU8.slice(outPtr, outPtr + outLen)).toString('utf8')
}

const { module, stderr } = await loadModule()
const initRc = module._dsh_init()
if (initRc !== 0) throw new Error(`dsh_init rc=${initRc}`)

const requests = [
  { id: 'r1', op: 'set', arg: 42 },
  { id: 'r2', op: 'get' },
  { id: 'r3', op: 'inc', arg: 1 },
  { id: 'r4', op: 'get' },
].map((request) => ({
  ...request,
  payload: request.arg === undefined
    ? `(request "${request.id}" ${request.op})`
    : `(request "${request.id}" ${request.op} ${request.arg})`,
}))
const responses = []
for (const request of requests) {
  const text = dispatch(module, request.payload)
  responses.push({ request, response: text, parsed: JSON.parse(text) })
}

const ok =
  responses.every((entry, index) => entry.parsed.id === requests[index].id && entry.parsed.ok === true) &&
  responses[0].parsed.value === 42 &&
  responses[1].parsed.value === 42 &&
  responses[2].parsed.value === 43 &&
  responses[3].parsed.value === 43

mkdirSync(RESULT_DIR, { recursive: true })
const result = {
  ok,
  transport: 'c-abi',
  checkedAt: new Date().toISOString(),
  requests,
  responses,
  stderr,
  asset: {
    js: createHash('sha256').update(readFileSync(join(ASSET_DIR, 'scheme-c.js'))).digest('hex'),
    wasm: createHash('sha256').update(readFileSync(join(ASSET_DIR, 'scheme-c.wasm'))).digest('hex'),
    data: createHash('sha256').update(readFileSync(join(ASSET_DIR, 'scheme-c.data'))).digest('hex'),
  },
}
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ ok, responses: responses.map((r) => r.parsed), stderr, out: OUT }, null, 2))
if (!ok) process.exit(1)
