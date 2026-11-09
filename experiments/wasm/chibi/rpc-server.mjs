import { readSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Persistent Chibi RPC prototype: one Wasm VM stays alive and reads JSON lines
// from fd 0. This is an experiment; it does not modify the production rules layer.
const here = dirname(fileURLToPath(import.meta.url))
const runtime = join(here, '0.12.0')
const require = createRequire(import.meta.url)
const [wasmBinary, data, guest] = await Promise.all([
  readFile(join(runtime, 'chibi.wasm')),
  readFile(join(runtime, 'chibi.data')),
  readFile(join(here, 'guest.scm'), 'utf8'),
])

globalThis.__CHIBI_PROGRAM__ = guest
const one = Buffer.alloc(1)
let closed = false

function stdinChar () {
  if (closed) return null
  try {
    const n = readSync(0, one, 0, 1, null)
    if (n === 0) return null
    return one[0]
  } catch (error) {
    if (error?.code === 'EAGAIN') return stdinChar()
    if (error?.code === 'EOF') return null
    throw error
  }
}

const createChibi = require(join(runtime, 'chibi.cjs'))
const runtimeDone = createChibi({
  wasmBinary,
  getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  stdin: stdinChar,
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
})
runtimeDone.finally(() => { closed = true })
