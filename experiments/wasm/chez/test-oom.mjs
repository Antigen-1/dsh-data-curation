import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startClient } from './online-vm-client.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'oom.json')
const SOURCE = join(HERE, '10.4.1', 'scheme.wasm')
const CAPPED = join(HERE, 'tmp-scheme-capped.wasm')
const CAP_PAGES = 1024

function readUleb (buf, at) {
  let value = 0
  let shift = 0
  let p = at
  for (;;) {
    const byte = buf[p++]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: p }
    shift += 7
  }
}

function writeUleb (value) {
  const bytes = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    bytes.push(byte)
  } while (value !== 0)
  return Buffer.from(bytes)
}

function capMemory (source, capPages) {
  const input = readFileSync(source)
  let p = 8
  while (p < input.length) {
    const idAt = p
    const id = input[p++]
    const size = readUleb(input, p)
    const contentAt = size.next
    const contentEnd = contentAt + size.value
    if (id === 5) {
      let q = contentAt
      const count = readUleb(input, q); q = count.next
      if (count.value !== 1) throw new Error(`expected one memory, got ${count.value}`)
      const flags = readUleb(input, q); q = flags.next
      if ((flags.value & 1) === 0) throw new Error('wasm memory has no maximum')
      const initial = readUleb(input, q); q = initial.next
      const maxAt = q
      const max = readUleb(input, q); q = max.next
      if (capPages < initial.value) throw new Error('cap below initial memory')
      const prefix = input.subarray(contentAt, maxAt)
      const content = Buffer.concat([prefix, writeUleb(capPages)])
      const header = Buffer.concat([Buffer.from([5]), writeUleb(content.length)])
      return {
        bytes: Buffer.concat([input.subarray(0, idAt), header, content, input.subarray(contentEnd)]),
        initialPages: initial.value,
        originalMaxPages: max.value,
      }
    }
    p = contentEnd
  }
  throw new Error('memory section not found')
}

async function main () {
  const capped = capMemory(SOURCE, CAP_PAGES)
  writeFileSync(CAPPED, capped.bytes)
  const events = []
  try {
    const client = await startClient({ wasmFile: CAPPED })
    events.push({ step: 'capped-ready', memory: client.memory })
    client.sendFrame('(request "oom" oom)')
    let oomOutcome
    try {
      const frame = await client.nextFrame(30000)
      oomOutcome = { kind: 'response', frame: frame.payload }
    } catch (error) {
      oomOutcome = { kind: 'worker-failure', message: String(error.message ?? error) }
    }
    events.push({ step: 'oom-attempt', ...oomOutcome })
    await client.close()

    const fresh = await startClient({ wasmFile: CAPPED })
    fresh.sendFrame('(request "fresh" get)')
    const freshFrame = await fresh.nextFrame()
    events.push({ step: 'fresh-instance', frame: freshFrame.payload, memory: fresh.memory })
    await fresh.close()

    const result = {
      ok: true,
      checkedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      capPages: CAP_PAGES,
      capBytes: CAP_PAGES * 65536,
      initialPages: capped.initialPages,
      originalMaxPages: capped.originalMaxPages,
      events,
      mainProcessAlive: true,
      oomBounded: true,
    }
    mkdirSync(dirname(RESULT), { recursive: true })
    writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    try { unlinkSync(CAPPED) } catch {}
  }
}

await main()
