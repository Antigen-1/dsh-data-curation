import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { inspectBinary, isBinary, parseChecksums } from '../scripts/selfcheck-lib.mjs'

const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('binary extensions are not decoded as text', () => {
  assert.equal(isBinary('assets/scheme-c.wasm'), true)
  assert.equal(isBinary('assets/boot.data'), true)
  assert.equal(isBinary('lib/index.js'), false)
  assert.equal(isBinary('README.md'), false)
})

test('checksum manifests accept sha256sum and shasum separators', () => {
  const a = digest(wasm)
  const map = parseChecksums(`${a}  assets/scheme-c.wasm\n${a} *assets/boot.data\nnot a checksum\n`)
  assert.equal(map.get('assets/scheme-c.wasm'), a)
  assert.equal(map.get('assets/boot.data'), a)
  assert.equal(map.size, 2)
})

test('binary inspection enforces wasm magic and digest', () => {
  const map = new Map([['assets/scheme-c.wasm', digest(wasm)]])
  assert.deepEqual(inspectBinary('assets/scheme-c.wasm', wasm, map), [])
  assert.match(inspectBinary('assets/scheme-c.wasm', Buffer.from('nope'), map).join('\n'), /magic/)
  assert.match(inspectBinary('assets/scheme-c.wasm', wasm, null).join('\n'), /SHA256SUMS/)
  assert.match(inspectBinary('assets/scheme-c.wasm', wasm, new Map()).join('\n'), /不在/)
  assert.match(inspectBinary('assets/scheme-c.wasm', wasm, new Map([['assets/scheme-c.wasm', '0'.repeat(64)]])).join('\n'), /hash/)
})
