'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

const here = __dirname
const asset = path.join(here, '10.4.1-hb')
const control = new Int32Array(workerData.control)
const response = new Uint8Array(workerData.response)
let stderrText = ''

function post (message) {
  parentPort.postMessage(message)
}

const m = {
  locateFile: (file) => path.join(asset, file),
  wasmBinary: fs.readFileSync(path.join(asset, 'scheme-hb.wasm')),
  printErr: (line) => { stderrText += String(line) + '\n' },
  print: () => {},
  quit: (status, toThrow) => { throw toThrow },
}

m.dshHostCall = (request) => {
  Atomics.store(control, 0, 0)
  post({ type: 'host-call', request })
  const wait = Atomics.wait(control, 0, 0, 5000)
  if (wait === 'timed-out') return JSON.stringify({ error: 'HOST_BRIDGE_TIMEOUT' })
  const length = Atomics.load(control, 1)
  return Buffer.from(response.slice(0, length)).toString('utf8')
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

function invoke (name, payload) {
  const bytes = Buffer.from(payload, 'utf8')
  const ptr = m._malloc(bytes.length)
  if (!ptr) throw new Error('malloc failed')
  try {
    m.HEAPU8.set(bytes, ptr)
    const rc = m[`_${name}`](ptr, bytes.length)
    if (rc !== 0) throw new Error(`${name} rc=${rc}`)
    const outPtr = m._dsh_out_ptr()
    const outLen = m._dsh_out_len()
    return Buffer.from(m.HEAPU8.slice(outPtr, outPtr + outLen)).toString('utf8')
  } finally {
    m._free(ptr)
  }
}

m.onRuntimeInitialized = () => {
  try {
    const rc = cstring('/host-bridge-probe.scm', (ptr) => m._dsh_set_guest(ptr))
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
      post({ type: 'response', id: message.id, text: invoke('dsh_dispatch', message.payload) })
    } catch (error) {
      post({ type: 'error', id: message.id, message: error && error.stack ? error.stack : String(error), stderr: stderrText })
    }
  })
}

const glue = fs.readFileSync(path.join(asset, 'scheme-hb.js'), 'utf8')
const code = glue.replace(/^var Module=/, 'var Module=globalThis.__dshModule; var __wasmModuleOriginal=')
globalThis.__dshModule = m
try {
  new Function('require', '__dirname', '__filename', 'process', 'Buffer', 'setTimeout', 'clearTimeout', code)(
    require,
    asset,
    path.join(asset, 'scheme-hb.js'),
    process,
    Buffer,
    setTimeout,
    clearTimeout,
  )
} catch (error) {
  post({ type: 'error', message: error && error.stack ? error.stack : String(error), stderr: stderrText })
}
