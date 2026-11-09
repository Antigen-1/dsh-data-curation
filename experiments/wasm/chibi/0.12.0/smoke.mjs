import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const wasmBinary = await readFile(join(here, 'chibi.wasm'))
const data = await readFile(join(here, 'chibi.data'))

globalThis.__CHIBI_PROGRAM__ = `
(import (scheme base) (scheme write))
(display (+ 1 2))
(newline)
`
const createChibi = require('./chibi.cjs')
const Chibi = await createChibi({
  wasmBinary,
  getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
})
console.error('chibi exited', Chibi)
