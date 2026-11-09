'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

const here = __dirname
const asset = path.join(here, '10.4.1')
const scriptName = workerData.scriptName || workerData.scriptFile || 'online-vm.scm'
const script = workerData.scriptSource ??
  fs.readFileSync(path.join(here, scriptName), 'utf8')

const ctrl = new Int32Array(workerData.control)
const input = new Uint8Array(workerData.input)
const output = new Uint8Array(workerData.output)
const wasmFile = workerData.wasmFile || path.join(asset, 'scheme.wasm')
const CAP = input.length
const MASK = CAP - 1

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
  // Returning undefined after one byte forces Emscripten's fd_read to return
  // a short read. The next fread call blocks in readByte instead of waiting
  // for a full libc buffer, which is what makes request/response interleaving
  // possible without a PTY.
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

let schemeCode = fs.readFileSync(path.join(asset, 'scheme.cjs'), 'utf8')
schemeCode = schemeCode.replace(
  'var Module=typeof Module!="undefined"?Module:{};',
  'var Module=globalThis.__dshModule;'
)
globalThis.fetch = undefined

const m = {
  locateFile: (file) => (file === 'scheme.wasm' ? wasmFile : path.join(asset, file)),
  noInitialRun: true,
  quit: (status, toThrow) => { throw toThrow },
  stdin,
  stdout,
  stderr,
  onRuntimeInitialized: () => {
    try {
      m.FS_createDataFile('/', scriptName, script, true, true, false)
      for (const extra of workerData.extraFiles || []) {
        m.FS_createDataFile('/', extra, fs.readFileSync(path.join(here, extra), 'utf8'), true, true, false)
      }
      const args = ['chez', '-q', '/' + scriptName]
      const argv = m.stackAlloc((args.length + 1) * 4)
      for (let i = 0; i < args.length; i++) {
        const bytes = Buffer.from(args[i] + '\0')
        const ptr = m.stackAlloc(bytes.length)
        m.HEAPU8.set(bytes, ptr)
        m.HEAP32[(argv >> 2) + i] = ptr
      }
      m.HEAP32[(argv >> 2) + args.length] = 0
      parentPort.postMessage({
        type: 'loaded',
        memory: {
          rss: process.memoryUsage().rss,
          wasmBytes: m.HEAPU8.length,
        },
      })
      let code = 0
      try {
        code = m._main(args.length, argv)
      } catch (error) {
        if (error && typeof error.status === 'number') code = error.status
        else throw error
      }
      parentPort.postMessage({ type: 'exit', code, stderr: stderrText.slice(-4000) })
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        message: error && error.stack ? error.stack : String(error),
        stderr: stderrText.slice(-4000),
      })
    }
  },
}

globalThis.__dshModule = m
new Function('require', '__dirname', '__filename', 'process', 'Buffer', schemeCode)(
  require, asset, path.join(asset, 'scheme.cjs'), process, Buffer
)
