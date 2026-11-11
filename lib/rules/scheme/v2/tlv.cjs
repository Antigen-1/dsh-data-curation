'use strict'

// Wire format: 4-byte big-endian frame length followed by a TLV payload.
// Strings are UTF-8 bytes with an explicit length; no JSON or whole-frame
// string parsing happens on either side of the channel.
const TAG_NULL = 0
const TAG_FALSE = 1
const TAG_TRUE = 2
const TAG_INT = 3
const TAG_FLOAT = 4
const TAG_STRING = 5
const TAG_ARRAY = 6
const TAG_OBJECT = 7
const MAX_FRAME = 65536
const MAX_DEPTH = 32

function encodeString (value) {
  return Buffer.from(value, 'utf8')
}

function encodeValue (value, out, depth) {
  if (depth > MAX_DEPTH) throw new Error('E-TLV-DEPTH')
  if (value === null || value === undefined) {
    out.push(Buffer.from([TAG_NULL]))
    return
  }
  if (value === false) {
    out.push(Buffer.from([TAG_FALSE]))
    return
  }
  if (value === true) {
    out.push(Buffer.from([TAG_TRUE]))
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('E-TLV-NUMBER')
    if (Number.isSafeInteger(value)) {
      const bytes = Buffer.alloc(9)
      bytes[0] = TAG_INT
      bytes.writeBigInt64BE(BigInt(value), 1)
      out.push(bytes)
      return
    }
    if (Number.isInteger(value)) throw new Error('E-TLV-RANGE')
    const bytes = Buffer.alloc(9)
    bytes[0] = TAG_FLOAT
    bytes.writeDoubleLE(value, 1)
    out.push(bytes)
    return
  }
  if (typeof value === 'string') {
    const bytes = encodeString(value)
    const head = Buffer.alloc(5)
    head[0] = TAG_STRING
    head.writeUInt32BE(bytes.length, 1)
    out.push(head, bytes)
    return
  }
  if (Array.isArray(value)) {
    const head = Buffer.alloc(5)
    head[0] = TAG_ARRAY
    head.writeUInt32BE(value.length, 1)
    out.push(head)
    for (const item of value) encodeValue(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    const head = Buffer.alloc(5)
    head[0] = TAG_OBJECT
    head.writeUInt32BE(entries.length, 1)
    out.push(head)
    for (const [key, item] of entries) {
      const keyBytes = encodeString(key)
      const keyHead = Buffer.alloc(4)
      keyHead.writeUInt32BE(keyBytes.length, 0)
      out.push(keyHead, keyBytes)
      encodeValue(item, out, depth + 1)
    }
    return
  }
  throw new Error('E-TLV-TYPE')
}

function encode (value) {
  const parts = []
  encodeValue(value, parts, 0)
  const payload = Buffer.concat(parts)
  if (payload.length > MAX_FRAME) throw new Error('E-TLV-FRAME')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length, 0)
  return Buffer.concat([head, payload])
}

function need (buffer, offset, length) {
  if (offset + length > buffer.length) throw new Error('E-TLV-TRUNCATED')
}

function decodeValue (buffer, offset, depth) {
  if (depth > MAX_DEPTH) throw new Error('E-TLV-DEPTH')
  need(buffer, offset, 1)
  const tag = buffer[offset]
  offset += 1
  switch (tag) {
    case TAG_NULL: return { value: null, offset }
    case TAG_FALSE: return { value: false, offset }
    case TAG_TRUE: return { value: true, offset }
    case TAG_INT: {
      need(buffer, offset, 8)
      const value = buffer.readBigInt64BE(offset)
      offset += 8
      const number = Number(value)
      if (!Number.isSafeInteger(number)) throw new Error('E-TLV-RANGE')
      return { value: number, offset }
    }
    case TAG_FLOAT: {
      need(buffer, offset, 8)
      const value = buffer.readDoubleLE(offset)
      offset += 8
      return { value, offset }
    }
    case TAG_STRING: {
      need(buffer, offset, 4)
      const length = buffer.readUInt32BE(offset)
      offset += 4
      need(buffer, offset, length)
      const value = buffer.subarray(offset, offset + length).toString('utf8')
      return { value, offset: offset + length }
    }
    case TAG_ARRAY: {
      need(buffer, offset, 4)
      const count = buffer.readUInt32BE(offset)
      offset += 4
      if (count > 1024) throw new Error('E-TLV-LENGTH')
      const value = []
      for (let index = 0; index < count; index += 1) {
        const item = decodeValue(buffer, offset, depth + 1)
        value.push(item.value)
        offset = item.offset
      }
      return { value, offset }
    }
    case TAG_OBJECT: {
      need(buffer, offset, 4)
      const count = buffer.readUInt32BE(offset)
      offset += 4
      if (count > 1024) throw new Error('E-TLV-LENGTH')
      const value = {}
      for (let index = 0; index < count; index += 1) {
        need(buffer, offset, 4)
        const keyLength = buffer.readUInt32BE(offset)
        offset += 4
        need(buffer, offset, keyLength)
        const key = buffer.subarray(offset, offset + keyLength).toString('utf8')
        offset += keyLength
        const item = decodeValue(buffer, offset, depth + 1)
        Object.defineProperty(value, key, {
          value: item.value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
        offset = item.offset
      }
      return { value, offset }
    }
    default: throw new Error('E-TLV-TAG')
  }
}

function decode (frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 4) throw new Error('E-TLV-FRAME')
  const length = frame.readUInt32BE(0)
  if (length > MAX_FRAME || frame.length !== length + 4) throw new Error('E-TLV-FRAME')
  const decoded = decodeValue(frame, 4, 0)
  if (decoded.offset !== frame.length) throw new Error('E-TLV-FRAME')
  return decoded.value
}

module.exports = { encode, decode, MAX_FRAME }
