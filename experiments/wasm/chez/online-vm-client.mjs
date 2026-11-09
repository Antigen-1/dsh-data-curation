import { Worker } from 'node:worker_threads'

const CAP = 1 << 20
const MASK = CAP - 1

export async function startClient (options = {}) {
  const control = new SharedArrayBuffer(8 * 4)
  const input = new SharedArrayBuffer(CAP)
  const output = new SharedArrayBuffer(CAP)
  const ctrl = new Int32Array(control)
  const inBuf = new Uint8Array(input)
  const outBuf = new Uint8Array(output)

  let inPos = 0
  let outRead = 0
  let buffered = Buffer.alloc(0)
  let exit = null
  let error = null
  let loadedMemory = null

  const worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
    workerData: { control, input, output, ...options },
  })
  worker.on('message', (message) => {
    if (message.type === 'loaded') loadedMemory = message.memory
    else if (message.type === 'exit') exit = message
    else if (message.type === 'error') error = message
  })
  worker.on('error', (e) => { error = { message: e.stack ?? String(e) } })

  function drain () {
    const end = Atomics.load(ctrl, 2)
    if (end <= outRead) return
    const chunk = Buffer.alloc(end - outRead)
    for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
    outRead = end
    Atomics.store(ctrl, 3, outRead)
    Atomics.notify(ctrl, 3)
    buffered = Buffer.concat([buffered, chunk])
  }

  async function readExact (n, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (buffered.length < n) {
      drain()
      if (error) throw new Error(`worker error: ${error.message}`)
      if (exit) throw new Error(`worker exited: ${JSON.stringify(exit)}`)
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${n} bytes`)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const bytes = buffered.subarray(0, n)
    buffered = buffered.subarray(n)
    return bytes
  }

  async function nextFrame (timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (!buffered.includes(0x0a)) {
      drain()
      if (error) throw new Error(`worker error: ${error.message}`)
      if (exit) throw new Error(`worker exited: ${JSON.stringify(exit)}`)
      if (Date.now() > deadline) throw new Error('timeout waiting for frame header')
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const at = buffered.indexOf(0x0a)
    const header = buffered.subarray(0, at).toString('ascii')
    buffered = buffered.subarray(at + 1)
    const length = Number(header)
    if (!Number.isInteger(length) || length < 0 || length > CAP) throw new Error(`bad frame length: ${header}`)
    const payload = await readExact(length, timeoutMs)
    const terminator = await readExact(1, timeoutMs)
    if (terminator[0] !== 0x0a) throw new Error('missing frame terminator')
    return { payload: payload.toString('utf8'), frameBytes: header.length + 1 + length + 1 }
  }

  function sendFrame (payload) {
    if (!/^[\x00-\x7f]*$/.test(payload)) throw new Error('protocol payload must be ASCII')
    const body = Buffer.from(payload, 'utf8')
    const frame = Buffer.concat([Buffer.from(`${body.length}\n`, 'ascii'), body, Buffer.from('\n', 'ascii')])
    const end = Atomics.load(ctrl, 0)
    const read = Atomics.load(ctrl, 1)
    if (end - read + frame.length > CAP) throw new Error('input ring full')
    for (let i = 0; i < frame.length; i++) {
      inBuf[(end + i) & MASK] = frame[i]
      Atomics.store(ctrl, 0, ++inPos)
    }
    Atomics.notify(ctrl, 0)
    return frame.length
  }

  async function waitExit (timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (!exit) {
      if (Date.now() > deadline) throw new Error('timeout waiting for worker exit')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return exit
  }

  async function terminate () {
    Atomics.store(ctrl, 4, 1)
    Atomics.notify(ctrl, 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return worker.terminate()
  }

  async function close () {
    Atomics.store(ctrl, 4, 1)
    Atomics.notify(ctrl, 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await worker.terminate()
  }

  const readyFrame = await nextFrame(30000)
  const ready = JSON.parse(readyFrame.payload)
  if (ready.ready !== true) throw new Error(`unexpected ready frame: ${readyFrame.payload}`)
  const loadedDeadline = Date.now() + 5000
  while (!loadedMemory && !error && Date.now() < loadedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (!loadedMemory) throw new Error('worker did not report loaded memory')

  return {
    ready,
    readyFrameBytes: readyFrame.frameBytes,
    memory: loadedMemory,
    nextFrame,
    sendFrame,
    waitExit,
    terminate,
    close,
    get exit () { return exit },
    get error () { return error },
  }
}
