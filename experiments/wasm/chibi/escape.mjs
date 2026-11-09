import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runtime = join(here, '0.12.0')
const require = createRequire(import.meta.url)
const [wasmBinary, data] = await Promise.all([
  readFile(join(runtime, 'chibi.wasm')),
  readFile(join(runtime, 'chibi.data')),
])
globalThis.__CHIBI_PROGRAM__ = `
(import (scheme base) (scheme write) (chibi emscripten))
(eval-script! "globalThis.__chibi_escape = 1")
(write-string (string-eval-script "String(globalThis.__chibi_escape)"))
(newline)
`
const createChibi = require(join(runtime, 'chibi.cjs'))
await createChibi({
  wasmBinary,
  getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
})
