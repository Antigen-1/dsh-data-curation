import { createHash } from 'node:crypto'
import { extname } from 'node:path'

export const CHECKSUM_MANIFEST = 'assets/SHA256SUMS'
export const BINARY_EXTENSIONS = new Set(['.wasm', '.data', '.node', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.gz', '.zip'])

export function isBinary(file) {
  return BINARY_EXTENSIONS.has(extname(file).toLowerCase())
}

export function parseChecksums(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (match) map.set(match[2].replaceAll('\\', '/'), match[1].toLowerCase())
  }
  return map
}

export function inspectBinary(file, bytes, checksums, manifestPath = CHECKSUM_MANIFEST) {
  const problems = []
  if (bytes.length === 0) problems.push(`二进制文件为空：${file}`)
  if (file.endsWith('.wasm') && !bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
    problems.push(`Wasm magic 不正确：${file}`)
  }
  if (!checksums) {
    problems.push(`二进制文件缺少 ${manifestPath}：${file}`)
    return problems
  }
  const expected = checksums.get(file)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (!expected) problems.push(`二进制文件不在 ${manifestPath}：${file}`)
  else if (expected !== actual) problems.push(`二进制文件 hash 不匹配：${file}`)
  return problems
}
