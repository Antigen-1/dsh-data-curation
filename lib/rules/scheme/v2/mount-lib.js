import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MOUNT_LIMITS = Object.freeze({
  maxMounts: 8,
  maxFiles: 2048,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  maxPathLength: 1024,
})

const RESERVED = ['/project', '/out', '/dev', '/online-vm-c.scm']

function mountError (code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

export function normalizeGuestPath (value) {
  if (typeof value !== 'string' || value.includes('\0')) return null
  const text = value.replaceAll('\\', '/')
  if (!text.startsWith('/')) return null
  const parts = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  if (parts.length === 0) return '/'
  return `/${parts.join('/')}`
}

function isUnder (root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`)
}

function overlaps (left, right) {
  return isUnder(left, right) || isUnder(right, left)
}

export function parseMountMode (value = 'r-x') {
  if (typeof value !== 'string' || !/^[r-][w-][x-]$/.test(value)) {
    throw mountError('E-MOUNT-CONFIG', `invalid mount mode: ${String(value)}`, {
      expected: 'three characters from r/w/x or -',
      actual: value,
    })
  }
  if (value[0] !== 'r') {
    throw mountError('E-MOUNT-CONFIG', 'mount mode must include read (r)', {
      expected: 'mode starting with r',
      actual: value,
    })
  }
  return {
    mode: value,
    read: true,
    write: value[1] === 'w',
    execute: value[2] === 'x',
  }
}

function validateGuestRoot (guestPath, index) {
  if (guestPath === null || guestPath === '/') {
    throw mountError('E-MOUNT-CONFIG', 'mount guestPath must be a non-root absolute path', {
      mount: index,
      guestPath,
    })
  }
  if (guestPath.length > MOUNT_LIMITS.maxPathLength) {
    throw mountError('E-MOUNT-LIMIT', 'mount guestPath is too long', {
      mount: index,
      guestPath,
      limit: MOUNT_LIMITS.maxPathLength,
    })
  }
  for (const reserved of RESERVED) {
    if (overlaps(guestPath, reserved)) {
      throw mountError('E-MOUNT-OVERLAP', `mount overlaps reserved path ${reserved}`, {
        mount: index,
        guestPath,
        reserved,
      })
    }
  }
}

function resolveHostRoot (projectRoot, hostPath, index) {
  if (typeof hostPath !== 'string' || hostPath.length === 0) {
    throw mountError('E-MOUNT-CONFIG', 'mount hostPath must be a non-empty string', { mount: index })
  }
  const root = isAbsolute(hostPath)
    ? resolve(hostPath)
    : resolve(projectRoot, hostPath)
  let stats
  try {
    stats = lstatSync(root)
  } catch (cause) {
    throw mountError('E-MOUNT-SOURCE', `mount hostPath is not accessible: ${hostPath}`, {
      mount: index,
      hostPath,
      cause: cause.code,
    })
  }
  if (stats.isSymbolicLink()) {
    throw mountError('E-MOUNT-SYMLINK', `mount hostPath is a symlink: ${hostPath}`, {
      mount: index,
      hostPath,
    })
  }
  if (!stats.isDirectory()) {
    throw mountError('E-MOUNT-SOURCE', `mount hostPath is not a directory: ${hostPath}`, {
      mount: index,
      hostPath,
    })
  }
  const real = realpathSync(root)
  if (!isAbsolute(hostPath)) {
    const projectReal = realpathSync(resolve(projectRoot))
    const relation = relative(projectReal, real)
    if (relation.startsWith('..') || isAbsolute(relation)) {
      throw mountError('E-MOUNT-SOURCE', 'relative hostPath escapes projectRoot', {
        mount: index,
        hostPath,
      })
    }
  }
  return real
}

function readRegularFile (absolute, guestPath, mode, counters) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  let fd
  try {
    fd = openSync(absolute, flags)
  } catch (cause) {
    throw mountError('E-MOUNT-READ', `failed to open mounted file: ${guestPath}`, {
      guestPath,
      cause: cause.code,
    })
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) {
      throw mountError('E-MOUNT-TYPE', `mounted path is not a regular file: ${guestPath}`, { guestPath })
    }
    if (stats.size > MOUNT_LIMITS.maxFileBytes) {
      throw mountError('E-MOUNT-LIMIT', `mounted file exceeds per-file limit: ${guestPath}`, {
        guestPath,
        limit: MOUNT_LIMITS.maxFileBytes,
        actual: stats.size,
      })
    }
    counters.files += 1
    if (counters.files > MOUNT_LIMITS.maxFiles) {
      throw mountError('E-MOUNT-LIMIT', 'mounted files exceed limit', {
        limit: MOUNT_LIMITS.maxFiles,
        actual: counters.files,
      })
    }
    counters.bytes += stats.size
    if (counters.bytes > MOUNT_LIMITS.maxTotalBytes) {
      throw mountError('E-MOUNT-LIMIT', 'mounted bytes exceed limit', {
        limit: MOUNT_LIMITS.maxTotalBytes,
        actual: counters.bytes,
      })
    }
    const content = readFileSync(fd)
    return {
      content,
      guestPath,
      size: stats.size,
      sha256: createHash('sha256').update(content).digest('hex'),
      directory: false,
      mode: mode.mode,
    }
  } finally {
    closeSync(fd)
  }
}

function walkMount (absoluteRoot, guestRoot, mode, counters, relativePath = '', depth = 0, entries = []) {
  if (depth > MOUNT_LIMITS.maxDepth) {
    throw mountError('E-MOUNT-LIMIT', 'mounted tree exceeds depth limit', {
      guestPath: guestRoot,
      limit: MOUNT_LIMITS.maxDepth,
    })
  }
  const directory = relativePath ? join(absoluteRoot, relativePath) : absoluteRoot
  const names = readdirSync(directory).sort()
  for (const name of names) {
    const relativeName = relativePath ? join(relativePath, name) : name
    const absolute = join(directory, name)
    const guestPath = `${guestRoot}/${relativeName.split(sep).join('/')}`
    const stats = lstatSync(absolute)
    if (stats.isSymbolicLink()) {
      throw mountError('E-MOUNT-SYMLINK', `mounted tree contains symlink: ${guestPath}`, { guestPath })
    }
    if (stats.isDirectory()) {
      entries.push({ guestPath, directory: true, mode: mode.mode })
      walkMount(absoluteRoot, guestRoot, mode, counters, relativeName, depth + 1, entries)
      continue
    }
    if (!stats.isFile()) {
      throw mountError('E-MOUNT-TYPE', `mounted tree contains non-regular file: ${guestPath}`, {
        guestPath,
      })
    }
    entries.push(readRegularFile(absolute, guestPath, mode, counters))
  }
  return entries
}

function manifestHash (entries) {
  const canonical = entries
    .map((entry) => ({
      path: entry.guestPath,
      type: entry.directory ? 'dir' : 'file',
      size: entry.directory ? 0 : entry.size,
      mode: entry.mode,
      sha256: entry.directory ? undefined : entry.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return `sha256:${createHash('sha256')
    .update('dsh/mount-manifest/v1\0')
    .update(JSON.stringify(canonical))
    .digest('hex')}`
}

export function readMounts (projectRoot, mounts, options = {}) {
  const allowSync = options.allowSync === true
  if (mounts === undefined || mounts === null) {
    return { files: [], mounts: [], manifestFiles: [] }
  }
  if (!Array.isArray(mounts)) {
    throw mountError('E-MOUNT-CONFIG', 'mounts must be an array')
  }
  if (mounts.length > MOUNT_LIMITS.maxMounts) {
    throw mountError('E-MOUNT-LIMIT', 'too many mounts', {
      limit: MOUNT_LIMITS.maxMounts,
      actual: mounts.length,
    })
  }
  const roots = []
  const files = []
  const directories = []
  const mountSummaries = []
  const manifestFiles = []
  const counters = { files: 0, bytes: 0 }
  for (let index = 0; index < mounts.length; index += 1) {
    const input = mounts[index]
    if (!input || typeof input !== 'object') {
      throw mountError('E-MOUNT-CONFIG', 'mount entry must be an object', { mount: index })
    }
    if (input.sync !== undefined && !allowSync) {
      throw mountError('E-MOUNT-CONFIG', 'mount sync is available in 0.25.0; this runtime is 0.24.0', {
        mount: index,
      })
    }
    const sync = input.sync === 'none' ? null : (input.sync ?? null)
    if (sync !== null && sync !== 'on-close') {
      throw mountError('E-MOUNT-CONFIG', `unsupported mount sync mode: ${String(input.sync)}`, {
        mount: index,
        expected: 'none or on-close',
        actual: input.sync,
      })
    }
    const mode = parseMountMode(input.mode ?? 'r-x')
    if (sync && (!mode.write || !mode.execute)) {
      throw mountError('E-MOUNT-CONFIG', 'sync mounts require write and execute permission', {
        mount: index,
        mode: mode.mode,
        sync,
      })
    }
    const guestPath = normalizeGuestPath(input.guestPath)
    validateGuestRoot(guestPath, index)
    for (const existing of roots) {
      if (overlaps(guestPath, existing)) {
        throw mountError('E-MOUNT-OVERLAP', `mount guest paths overlap: ${guestPath} and ${existing}`, {
          mount: index,
          guestPath,
          existing,
        })
      }
    }
    roots.push(guestPath)
    directories.push(guestPath)
    const hostRoot = resolveHostRoot(projectRoot, input.hostPath, index)
    const entries = []
    const mountFilesBefore = counters.files
    const mountBytesBefore = counters.bytes
    walkMount(hostRoot, guestPath, mode, counters, '', 0, entries)
    for (const entry of entries) {
      if (entry.directory) {
        directories.push(entry.guestPath)
        continue
      }
      files.push({
        path: entry.guestPath,
        content: entry.content,
        readonly: !mode.write,
        mode: mode.mode,
      })
      manifestFiles.push(entry)
    }
    mountSummaries.push({
      guestPath,
      hostRoot,
      sync,
      mode: mode.mode,
      files: counters.files - mountFilesBefore,
      bytes: counters.bytes - mountBytesBefore,
      manifestHash: manifestHash(entries),
      manifest: entries.map((entry) => ({
        path: entry.guestPath,
        directory: entry.directory === true,
        size: entry.size,
        sha256: entry.sha256,
      })),
      permissions: mode,
    })
  }
  assertMountFiles(files)
  return { files, directories, mounts: mountSummaries, manifestFiles }
}

export function assertMountFiles (files) {
  if (!Array.isArray(files)) throw mountError('E-MOUNT-CONFIG', 'mountFiles must be an array')
  for (const file of files) {
    if (!file || typeof file !== 'object') throw mountError('E-MOUNT-CONFIG', 'invalid mount file')
    const path = normalizeGuestPath(file.path)
    if (path === null) throw mountError('E-MOUNT-CONFIG', 'invalid mount file path')
    if (!(file.content instanceof Uint8Array) && !Buffer.isBuffer(file.content)) {
      throw mountError('E-MOUNT-CONFIG', `mount file content must be bytes: ${path}`)
    }
  }
  return true
}
