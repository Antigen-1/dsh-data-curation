import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { encode, decode, MAX_FRAME } = require('../lib/rules/scheme/v2/tlv.cjs')

test('TLV round-trips the FFI frame shape', () => {
  const frame = {
    id: 'ffi',
    rid: 'ffi-1',
    kind: 'ffi',
    rule: 'rule.example',
    target: 'math.add',
    token: 'token',
    args: [2, 3, -1, 1.5, true, false, null, 'text'],
  }
  const encoded = encode(frame)
  assert.equal(encoded.readUInt32BE(0), encoded.length - 4)
  assert.deepEqual(decode(encoded), frame)
})

test('TLV round-trips UTF-8 and empty frames', () => {
  assert.deepEqual(decode(encode({ text: '中文', empty: [] })), { text: '中文', empty: [] })
  assert.throws(() => decode(Buffer.alloc(4)), /E-TLV-/)
})

test('TLV rejects truncated and oversized frames', () => {
  const encoded = encode({ ok: true, value: 42 })
  assert.throws(() => decode(encoded.subarray(0, encoded.length - 1)), /E-TLV-FRAME/)
  const malformed = Buffer.alloc(4)
  malformed.writeUInt32BE(MAX_FRAME + 1, 0)
  assert.throws(() => decode(malformed), /E-TLV-FRAME/)
})

test('TLV does not let __proto__ reshape decoded prototypes', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true}}')
  const decoded = decode(encode(payload))
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype)
  assert.equal(decoded.polluted, undefined)
  assert.deepEqual(Object.keys(decoded), ['__proto__'])
  assert.deepEqual(decoded.__proto__, { polluted: true })
})

test('TLV preserves integral flonums and rejects unsafe integers', () => {
  assert.deepEqual(decode(encode([2.0, 2.5])), [2.0, 2.5])
  assert.throws(() => encode(2 ** 60), /E-TLV-RANGE/)
})

test('worker creates per-incarnation channel devices', () => {
  const source = readFileSync(new URL('../lib/rules/scheme/v2/worker.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:stdin|stdout)\s*:/)
  assert.match(source, /crypto\.randomBytes\(16\)\.toString\('hex'\)/)
  assert.match(source, /installBridgeDevices\(channelSuffix\)/)
  assert.match(source, /`dsh-in-\$\{suffix\}`/)
  assert.match(source, /`dsh-out-\$\{suffix\}`/)
  assert.doesNotMatch(source, /createDevice\('\/dev',\s*'dsh-in'\)/)
  assert.doesNotMatch(source, /createDevice\('\/dev',\s*'dsh-out'\)/)
})

test('guest channel path is patched from exactly one placeholder', () => {
  const source = readFileSync(new URL('../native/chez/online-vm-c.scm', import.meta.url), 'utf8')
  assert.equal(source.split('__DSH_CHANNEL_SUFFIX__').length - 1, 1)
  assert.match(source, /\(string-append "\/dev\/dsh-in-" dsh-channel-suffix\)/)
  assert.match(source, /\(string-append "\/dev\/dsh-out-" dsh-channel-suffix\)/)
})
