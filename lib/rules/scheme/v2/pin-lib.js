import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const REQUIRED_ENGINE_FILES = Object.freeze([
  'scheme-c.js',
  'scheme-c.wasm',
  'scheme-c.data',
  'online-vm-abi.json',
])
export const REQUIRED_ABI_EXPORTS = Object.freeze([
  '_dsh_init', '_dsh_dispatch', '_dsh_resume', '_dsh_out_ptr', '_dsh_out_len',
  '_dsh_set_guest', '_dsh_mount_file', '_dsh_read_file', '_dsh_file_size',
  '_dsh_out_size', '_dsh_out_count',
])
export const REQUIRED_ABI_GUEST = 'online-vm-c.scm'

function safeRelativePath (value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) return false
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function canonicalJson (value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in canonical JSON')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new Error(`unsupported canonical JSON value: ${typeof value}`)
}

export function sha256Hex (buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function decodeSourceBase64 (text) {
  if (typeof text !== 'string' || text.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error('E-PIN-SOURCE-BASE64')
  }
  const bytes = Buffer.from(text, 'base64')
  if (bytes.toString('base64') !== text) throw new Error('E-PIN-SOURCE-BASE64')
  let decoded
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('E-PIN-SOURCE-UTF8')
  }
  if (decoded.includes('\u0000')) throw new Error('E-PIN-SOURCE-NUL')
  return decoded
}

export function schemeString (text) {
  return `"${String(text)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}"`
}

export function schemeValue (value) {
  if (value === null) return "'()"
  if (typeof value === 'boolean') return value ? '#t' : '#f'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value)
  if (typeof value === 'string') return schemeString(value)
  if (Array.isArray(value)) return `(${value.map(schemeValue).join(' ')})`
  if (typeof value === 'object') {
    return `(${Object.keys(value).sort().map((k) => `(${schemeString(k)} . ${schemeValue(value[k])})`).join(' ')})`
  }
  throw new Error(`unsupported Scheme value: ${typeof value}`)
}

export function loadEngineRegistry (registryPath) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  if (registry.schema !== 'dsh-engine-registry/v1' || typeof registry.engines !== 'object') {
    throw new Error('E-ENGINE-REGISTRY')
  }
  return registry
}

export function readDataArchive (jsPath, dataPath) {
  const js = readFileSync(jsPath, 'utf8')
  const data = readFileSync(dataPath)
  const match = js.match(/"files":(\[[^\]]*\]),"remote_package_size":(\d+)/)
  if (!match) throw new Error('E-ENGINE-DATA-METADATA')
  let files
  try {
    files = JSON.parse(match[1])
  } catch {
    throw new Error('E-ENGINE-DATA-METADATA')
  }
  const remotePackageSize = Number(match[2])
  if (!Array.isArray(files) || files.length === 0 ||
      !Number.isInteger(remotePackageSize) || remotePackageSize !== data.length) {
    throw new Error('E-ENGINE-DATA-SIZE')
  }
  const names = new Set()
  const inventory = []
  let cursor = 0
  for (const file of files) {
    if (!file || typeof file.filename !== 'string' || !file.filename.startsWith('/') ||
        file.filename.includes('\u0000') || file.filename.split('/').includes('..') ||
        names.has(file.filename)) {
      throw new Error('E-ENGINE-DATA-FILE')
    }
    names.add(file.filename)
    if (!Number.isInteger(file.start) || !Number.isInteger(file.end) ||
        file.start !== cursor || file.end <= file.start || file.end > data.length) {
      throw new Error('E-ENGINE-DATA-OFFSET')
    }
    const slice = data.subarray(file.start, file.end)
    inventory.push({
      filename: file.filename,
      start: file.start,
      end: file.end,
      sha256: sha256Hex(slice),
      size: slice.length,
    })
    cursor = file.end
  }
  if (cursor !== data.length) throw new Error('E-ENGINE-DATA-TRAILING')
  return { remotePackageSize, files: inventory }
}

export function validateAbiManifest (abi, contract) {
  if (!abi || abi.contract !== contract || abi.guest !== REQUIRED_ABI_GUEST ||
      abi.continuation_resume !== false) {
    throw new Error('E-ENGINE-ABI')
  }
  if (!Array.isArray(abi.exports) || REQUIRED_ABI_EXPORTS.some((name) => !abi.exports.includes(name))) {
    throw new Error('E-ENGINE-ABI-EXPORT')
  }
  return abi
}

export function verifyEngine (registryPath, contract, assetsRoot) {
  const registry = loadEngineRegistry(registryPath)
  const entry = registry.engines[contract]
  if (!entry) throw new Error('E-ENGINE-NOT-APPROVED')
  if (!Array.isArray(entry.closure) || entry.closure.length !== REQUIRED_ENGINE_FILES.length) {
    throw new Error('E-ENGINE-CLOSURE')
  }
  if (!safeRelativePath(entry.assetsDir || '')) throw new Error('E-ENGINE-PATH')
  const root = resolve(assetsRoot)
  const base = resolve(root, entry.assetsDir)
  if (base !== root && !base.startsWith(`${root}${sep}`)) throw new Error('E-ENGINE-PATH')

  const expectedPaths = new Set(REQUIRED_ENGINE_FILES)
  const seenPaths = new Set()
  const files = []
  for (const item of entry.closure) {
    if (!safeRelativePath(item.path)) throw new Error('E-ENGINE-PATH')
    if (!expectedPaths.has(item.path)) throw new Error(`E-ENGINE-UNEXPECTED:${item.path}`)
    if (seenPaths.has(item.path)) throw new Error(`E-ENGINE-DUPLICATE:${item.path}`)
    seenPaths.add(item.path)
    if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error(`E-ENGINE-DIGEST:${item.path}`)
    }
    if (!Number.isInteger(item.size) || item.size < 1) throw new Error(`E-ENGINE-SIZE:${item.path}`)
    const bytes = readFileSync(join(base, item.path))
    const digest = sha256Hex(bytes)
    if (digest !== item.sha256) throw new Error(`E-ENGINE-HASH:${item.path}`)
    if (item.size !== bytes.length) throw new Error(`E-ENGINE-SIZE:${item.path}`)
    files.push({ path: item.path, sha256: digest, size: bytes.length })
  }
  for (const required of REQUIRED_ENGINE_FILES) {
    if (!seenPaths.has(required)) throw new Error(`E-ENGINE-REQUIRED:${required}`)
  }

  let abi
  try {
    abi = JSON.parse(readFileSync(join(base, 'online-vm-abi.json'), 'utf8'))
  } catch {
    throw new Error('E-ENGINE-ABI')
  }
  validateAbiManifest(abi, contract)

  const dataArchive = readDataArchive(join(base, 'scheme-c.js'), join(base, 'scheme-c.data'))
  if (!entry.dataArchive || canonicalJson(entry.dataArchive) !== canonicalJson(dataArchive)) {
    throw new Error('E-ENGINE-DATA-MANIFEST')
  }

  const expected = `sha256:${sha256Hex(canonicalJson({ contract, files, dataArchive }))}`
  if (entry.engineArtifactHash !== expected) throw new Error('E-ENGINE-MANIFEST-HASH')
  return { entry, files, dataArchive, engineArtifactHash: expected, assetsDir: base }
}

export function pinEngine (pin) {
  if (!pin || typeof pin !== 'object') throw new Error('E-PIN-SCHEMA')
  if (pin.schema !== 'dsh-pin/v2') throw new Error('E-PIN-SCHEMA')
  if (!pin.engine || typeof pin.engine.contract !== 'string' || typeof pin.engine.engineArtifactHash !== 'string') {
    throw new Error('E-PIN-ENGINE')
  }
  if (!Array.isArray(pin.modules) || !Array.isArray(pin.rules) || !Array.isArray(pin.plugins) || !Array.isArray(pin.ffi)) {
    throw new Error('E-PIN-SCHEMA')
  }
  return pin
}

export function registryDir (registryPath) {
  return dirname(registryPath)
}
