// lib/zip.js — a minimal, dependency-free ZIP writer.
//
// Node ships zlib but no archive writer, and the plugin promises zero runtime
// dependencies. This writer emits a conventional ZIP (deflate, UTF-8 names)
// that `unzip`, Explorer and Archive Utility all understand.
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xFFFF
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF

/**
 * Build a ZIP archive in memory.
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @returns {Buffer}
 */
const MAX32 = 0xffffffff

/**
 * Zip64 is deliberately not implemented: this writer is for project packs
 * (a workspace snapshot + a handful of scripts), and a silent RangeError in
 * the middle of a 4 GiB archive is worse than an explicit refusal.
 */
function checkLimits(entries) {
  if (entries.length > 0xffff) throw new Error(`打包条目过多（${entries.length} > 65535），暂不支持 zip64`)
  let total = 0
  for (const e of entries) {
    const size = Buffer.isBuffer(e.data) ? e.data.length : Buffer.byteLength(String(e.data ?? ''), 'utf8')
    total += size
  }
  if (total > MAX32) throw new Error(`打包内容过大（${total} 字节 > 4 GiB），暂不支持 zip64`)
}

export function createZip(entries) {
  checkLimits(entries)
  const now = new Date()
  const time = dosTime(now)
  const date = dosDate(now)
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, compressed)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014B50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += local.length + name.length + compressed.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}
