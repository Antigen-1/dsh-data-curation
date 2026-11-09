'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

const here = __dirname
const asset = path.join(here, '10.4.1-c')
const ctrl = new Int32Array(workerData.control)
const input = new Uint8Array(workerData.input)
const output = new Uint8Array(workerData.output)
const CAP = input.length
const MASK = CAP - 1
const MAX_OUTPUT_BYTES = 1000000
const IN_POS = 0
const IN_READ = 1
const OUT_POS = 2
const OUT_READ = 3
const SHUTDOWN = 4

let deliveredInBurst = false
let stderrText = ''

function readByte () {
  for (;;) {
    const inPos = Atomics.load(ctrl, IN_POS)
    const inRead = Atomics.load(ctrl, IN_READ)
    if (inRead < inPos) {
      const byte = input[inRead & MASK]
      Atomics.store(ctrl, IN_READ, inRead + 1)
      Atomics.notify(ctrl, IN_READ)
      return byte
    }
    if (Atomics.load(ctrl, SHUTDOWN) === 1) return null
    Atomics.wait(ctrl, IN_POS, inPos, 1000)
  }
}

function stdin () {
  if (deliveredInBurst) {
    deliveredInBurst = false
    return undefined
  }
  const byte = readByte()
  if (byte === null) return null
  deliveredInBurst = true
  return byte
}

function stdout (byte) {
  for (;;) {
    const outPos = Atomics.load(ctrl, OUT_POS)
    const outRead = Atomics.load(ctrl, OUT_READ)
    if (outPos - outRead < CAP) {
      output[outPos & MASK] = byte
      Atomics.store(ctrl, OUT_POS, outPos + 1)
      if (byte === 0x0a) Atomics.notify(ctrl, OUT_POS)
      return
    }
    Atomics.wait(ctrl, OUT_READ, outRead, 1000)
  }
}

function stderr (byte) {
  stderrText += String.fromCharCode(byte)
  if (stderrText.length > 100000) stderrText = stderrText.slice(-100000)
}

const m = {
  locateFile: (file) => path.join(asset, file),
  wasmBinary: fs.readFileSync(path.join(asset, 'scheme-c.wasm')),
  stdin,
  stdout,
  stderr,
  print: () => {},
  printErr: (line) => { stderrText += String(line) + '\n' },
  quit: (status, toThrow) => { throw toThrow },
}

function post (message) {
  parentPort.postMessage(message)
}

function cstring (text, fn) {
  const bytes = Buffer.from(text + '\0', 'utf8')
  const ptr = m._malloc(bytes.length)
  if (!ptr) throw new Error('malloc failed')
  try {
    m.HEAPU8.set(bytes, ptr)
    return fn(ptr)
  } finally {
    m._free(ptr)
  }
}

function dispatch (payload) {
  const bytes = Buffer.from(payload, 'utf8')
  const ptr = m._malloc(bytes.length)
  if (!ptr) throw new Error('malloc failed')
  try {
    m.HEAPU8.set(bytes, ptr)
    const rc = m._dsh_dispatch(ptr, bytes.length)
    if (rc !== 0) throw new Error(`dsh_dispatch rc=${rc}`)
    const outPtr = m._dsh_out_ptr()
    const outLen = m._dsh_out_len()
    if (outPtr === 0 || outLen < 0 || outLen > MAX_OUTPUT_BYTES) {
      throw new Error(`bad output ptr=${outPtr} len=${outLen}`)
    }
    if (outPtr + outLen > m.HEAPU8.length) throw new Error('output outside wasm heap')
    return Buffer.from(m.HEAPU8.slice(outPtr, outPtr + outLen)).toString('utf8')
  } finally {
    m._free(ptr)
  }
}

m.onRuntimeInitialized = () => {
  try {
    const guestFile = workerData.guestFile || '/host-bridge-probe.scm'
    if (!workerData.guestFile) {
      const guest = fs.readFileSync(path.join(here, 'host-bridge-probe.scm'), 'utf8')
      m.FS.createDataFile('/', 'host-bridge-probe.scm', guest, true, true, false)
    }
    const rc = cstring(guestFile, (ptr) => m._dsh_set_guest(ptr))
    if (rc !== 0) throw new Error(`dsh_set_guest rc=${rc}`)
    const init = m._dsh_init()
    if (init !== 0) throw new Error(`dsh_init rc=${init}`)
    post({ type: 'loaded' })
  } catch (error) {
    post({ type: 'error', message: error && error.stack ? error.stack : String(error), stderr: stderrText })
    return
  }

  parentPort.on('message', (message) => {
    if (message.type !== 'dispatch') return
    try {
      post({ type: 'response', id: message.id, text: dispatch(message.payload) })
    } catch (error) {
      post({ type: 'error', id: message.id, message: error && error.stack ? error.stack : String(error), stderr: stderrText })
    }
  })
}

const glue = fs.readFileSync(path.join(asset, 'scheme-c.js'), 'utf8')
const code = glue.replace(/^var Module=/, 'var Module=globalThis.__dshModule; var __wasmModuleOriginal=')
globalThis.__dshModule = m
try {
  new Function('require', '__dirname', '__filename', 'process', 'Buffer', 'setTimeout', 'clearTimeout', code)(
    require,
    asset,
    path.join(asset, 'scheme-c.js'),
    process,
    Buffer,
    setTimeout,
    clearTimeout,
  )
} catch (error) {
  post({ type: 'error', message: error && error.stack ? error.stack : String(error), stderr: stderrText })
}
