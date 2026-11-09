import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runtime = join(here, '0.12.0')
const require = createRequire(import.meta.url)
const [wasmBinary, data, guest] = await Promise.all([
  readFile(join(runtime, 'chibi.wasm')),
  readFile(join(runtime, 'chibi.data')),
  readFile(join(here, 'guest.scm'), 'utf8'),
])

globalThis.__CHIBI_PROGRAM__ = guest
const input = readFileSync(0, 'utf8')
let inputIndex = 0
const createChibi = require(join(runtime, 'chibi.cjs'))
await createChibi({
  wasmBinary,
  getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  stdin: () => inputIndex < input.length ? input.charCodeAt(inputIndex++) : null,
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
})
