'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parentPort, workerData } = require('node:worker_threads')
const hostPath = require('./host-path.cjs')

const here = __dirname
const asset = workerData?.assetDir ? path.resolve(here, workerData.assetDir) : path.join(here, '10.4.1-c')
const MAX_OUTPUT_BYTES = 1000000
const MOUNT_SYNC_LIMITS = {
  maxFiles: 2048,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
}
let stderrText = ''

// Optional blocking host bridge. It is enabled only when the runtime supplies
// shared rings and an explicit FFI allowlist. The guest blocks in Wasm while the
// host thread services one TLV frame.
const bridge = workerData?.bridge || null
const CAP = 1 << 20
const MASK = CAP - 1
const IN_POS = 0
const IN_READ = 1
const OUT_POS = 2
const OUT_READ = 3
const SHUTDOWN = 4
const ctrl = bridge ? new Int32Array(bridge.control) : null
const input = bridge ? new Uint8Array(bridge.input) : null
const output = bridge ? new Uint8Array(bridge.output) : null
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

function bridgeStdout (byte) {
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

function appendStderr (line) {
  stderrText += String(line) + '\n'
  if (stderrText.length > 100000) stderrText = stderrText.slice(-100000)
}

const m = {
  locateFile: (file) => path.join(asset, file),
  wasmBinary: fs.readFileSync(path.join(asset, 'scheme-c.wasm')),
  printErr: appendStderr,
  print: () => {},
  quit: (status, toThrow) => { throw toThrow },
}

let exitStatus = null

function invoke (name, payload) {
  const bytes = Buffer.from(payload, 'utf8')
  const ptr = m._malloc(bytes.length)
  if (!ptr) throw new Error('malloc failed')
  try {
    m.HEAPU8.set(bytes, ptr)
    const rc = m[`_${name}`](ptr, bytes.length)
    if (rc === -2) {
      throw Object.assign(new Error(`${name} exceeded the 1000000-byte C output cap`), {
        code: 'E-OUTPUT-LIMIT',
      })
    }
    if (rc !== 0) throw new Error(`${name} rc=${rc}`)
    const outPtr = m._dsh_out_ptr()
    const outLen = m._dsh_out_len()
    if (outLen > MAX_OUTPUT_BYTES) {
      throw Object.assign(new Error(`E-OUTPUT-LIMIT ptr=${outPtr} len=${outLen}`), { code: 'E-OUTPUT-LIMIT' })
    }
    if (outPtr === 0 || outLen < 0) {
      throw Object.assign(new Error(`bad output ptr=${outPtr} len=${outLen}`), { code: 'E-OUTPUT-PTR' })
    }
    if (outPtr + outLen > m.HEAPU8.length) {
      throw Object.assign(new Error('E-OUTPUT-HEAP'), { code: 'E-OUTPUT-HEAP' })
    }
    return Buffer.from(m.HEAPU8.slice(outPtr, outPtr + outLen)).toString('utf8')
  } finally {
    m._free(ptr)
  }
}

function dispatch (payload) {
  return invoke('dsh_dispatch', payload)
}

function resume (payload) {
  return invoke('dsh_resume', payload)
}

function cstring (text, fn) {
  const bytes = Buffer.from(text + '\0', 'utf8')
  const ptr = m._malloc(bytes.length)
  if (!ptr) throw new Error('malloc failed')
  try {
    m.HEAPU8.set(bytes, ptr)
    return fn(ptr)
  } finally {
    m._free(ptr)
  }
}

function normalizeGuestPath (value) {
  if (typeof value !== 'string' || value.includes('\0')) return null
  const text = value.replaceAll('\\', '/')
  if (!text.startsWith('/')) return null
  const parts = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

function installReadOnlyProjectGuard (mountModes = []) {
  if (!m.FS || !m.FS.open) return
  const MAX_OUT_BYTES = 65536
  const MAX_OUT_FILES = 8
  let outBytes = 0
  const mounts = mountModes
    .map((entry) => {
      const root = normalizeGuestPath(entry.guestPath)
      if (root === null) return null
      const permissions = entry.permissions || {}
      return {
        root,
        read: permissions.read !== false,
        write: permissions.write === true,
        execute: permissions.execute === true,
      }
    })
    .filter(Boolean)
  const findMount = (p) => {
    const path = normalizeGuestPath(p)
    if (path === null) return null
    return mounts.find((mount) => path === mount.root || path.startsWith(`${mount.root}/`)) || null
  }
  const mountAncestor = (p) => {
    const path = normalizeGuestPath(p)
    if (path === null) return false
    const prefix = path === '/' ? '/' : `${path}/`
    return mounts.some((mount) => mount.root !== path && mount.root.startsWith(prefix))
  }
  const underProject = (p) => {
    const path = normalizeGuestPath(p)
    return path !== null && (path === '/project' || path.startsWith('/project/'))
  }
  const underOut = (p) => {
    const path = normalizeGuestPath(p)
    return path !== null && (path === '/out' || path.startsWith('/out/'))
  }
  const writeFlags = (flags) => (flags & 3) !== 0 || (flags & 64) !== 0 || (flags & 512) !== 0 || (flags & 1024) !== 0
  const deny = (errno = 30) => { throw new m.FS.ErrnoError(errno) }
  const open = m.FS.open
  m.FS.open = function (path, flags, mode) {
    if (typeof path !== 'string') return open.call(this, path, flags, mode)
    const normalized = normalizeGuestPath(path)
    if (normalized === null) deny(13)
    if (underProject(normalized) && writeFlags(flags)) deny()
    const mount = findMount(normalized)
    if (mount) {
      if (writeFlags(flags) && (!mount.write || !mount.execute)) deny()
      if (!writeFlags(flags) && (!mount.read || !mount.execute)) deny()
    }
    if (underOut(normalized) && (flags & 64) !== 0) {
      try {
        if (m.FS.readdir('/out').filter((name) => name !== '.' && name !== '..').length >= MAX_OUT_FILES) deny(28)
      } catch (error) {
        if (error && error.errno === 28) throw error
      }
    }
    return open.call(this, normalized, flags, mode)
  }
  if (typeof m.FS.readdir === 'function') {
    const readdir = m.FS.readdir
    m.FS.readdir = function (path) {
      let target = path
      if (typeof path === 'string') {
        const normalized = normalizeGuestPath(path)
        if (normalized === null) deny(13)
        const mount = findMount(normalized)
        if (mount && !mount.read) deny(13)
        target = normalized
      }
      return readdir.call(this, target)
    }
  }
  if (typeof m.FS.write === 'function') {
    const write = m.FS.write
    m.FS.write = function (stream, buffer, offset, length, position) {
      const path = stream && stream.path ? String(stream.path) : ''
      if (path && underOut(path)) {
        if (outBytes + length > MAX_OUT_BYTES) deny(28)
        outBytes += length
      }
      return write.call(this, stream, buffer, offset, length, position)
    }
  }
  for (const name of ['unlink', 'rmdir', 'rename', 'chmod', 'truncate', 'mkdir', 'chown', 'utime']) {
    const original = m.FS[name]
    if (typeof original !== 'function') continue
    m.FS[name] = function (path, ...rest) {
      if (typeof path !== 'string') return original.call(this, path, ...rest)
      const normalized = normalizeGuestPath(path)
      if (normalized === null) deny(13)
      if (underProject(normalized) || (name === 'rename' && underProject(rest[0]))) deny()
      if (mountAncestor(normalized)) deny(13)
      const mount = findMount(normalized)
      if (mount && (!mount.write || !mount.execute)) deny()
      if (mount && normalized === mount.root && (name === 'rename' || name === 'rmdir')) deny(13)
      if (name === 'rename') {
        const target = normalizeGuestPath(rest[0])
        if (target === null) deny(13)
        if (mountAncestor(target)) deny(13)
        const targetMount = findMount(target)
        if (targetMount && (!targetMount.write || !targetMount.execute)) deny()
        if (underOut(target) && !underOut(normalized)) deny(28)
      }
      const args = name === 'rename' ? [normalizeGuestPath(rest[0]), ...rest.slice(1)] : rest
      if (name === 'rename' && args[0] === null) deny(13)
      return original.call(this, normalized, ...args)
    }
  }
  // Hard links and symlinks are not part of the experimental capability set:
  // reject creation instead of trying to reason about a second path.
  for (const name of ['symlink', 'link']) {
    const original = m.FS[name]
    if (typeof original !== 'function') continue
    m.FS[name] = function () { deny(30) }
  }
}

function installBridgeDevices (suffix) {
  if (!bridge || !m.FS || typeof m.FS.createDevice !== 'function') return
  m.FS.createDevice('/dev', `dsh-in-${suffix}`, () => readByte(), () => 0)
  m.FS.createDevice('/dev', `dsh-out-${suffix}`, () => null, (byte) => {
    bridgeStdout(byte)
    return byte
  })
}

function patchGuestChannelSuffix (suffix) {
  if (!m.FS || typeof m.FS.readFile !== 'function' || typeof m.FS.writeFile !== 'function') {
    throw new Error('E-CHANNEL-MANIFEST: Emscripten FS is unavailable')
  }
  const placeholder = '__DSH_CHANNEL_SUFFIX__'
  const source = Buffer.from(m.FS.readFile('/online-vm-c.scm')).toString('utf8')
  const count = source.split(placeholder).length - 1
  if (count !== 1) {
    throw new Error(`E-CHANNEL-MANIFEST: expected one ${placeholder}, found ${count}`)
  }
  m.FS.writeFile('/online-vm-c.scm', source.replace(placeholder, suffix))
}

function mountProjectFile (file) {
  const content = Buffer.from(file.content, 'utf8')
  const guestPath = normalizeGuestPath(file.path)
  if (guestPath === null || !guestPath.startsWith('/project/')) {
    throw new Error(`project file outside /project: ${file.path}`)
  }
  mountFile({ path: guestPath, content, readonly: true })
}

function mountFile (file) {
  const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content)
  const guestPath = normalizeGuestPath(file.path)
  if (guestPath === null) {
    throw new Error(`mount file has invalid path: ${file.path}`)
  }
  if (m.FS) {
    const slash = guestPath.lastIndexOf('/')
    const dir = guestPath.slice(0, slash)
    m.FS.mkdirTree(dir)
    m.FS.createDataFile(dir, guestPath.slice(slash + 1), content, true, file.readonly !== true, false)
    return
  }
  const dataPtr = m._malloc(content.length)
  if (!dataPtr) throw new Error('malloc failed for project file')
  try {
    m.HEAPU8.set(content, dataPtr)
    const rc = cstring(guestPath, (pathPtr) =>
      m._dsh_mount_file(pathPtr, dataPtr, content.length, file.readonly === false ? 0 : 1))
    if (rc !== 0) throw new Error(`dsh_mount_file ${guestPath} rc=${rc}`)
  } finally {
    m._free(dataPtr)
  }
}

function syncPathError (message, target) {
  const error = new Error(message)
  error.code = 'E-MOUNT-SYNC-PATH'
  error.target = target
  return error
}

function syncLimitError (message, target, limit, actual) {
  const error = new Error(message)
  error.code = 'E-MOUNT-LIMIT'
  error.target = target
  error.limit = limit
  error.actual = actual
  return error
}

function assertSyncPath (hostRoot, target) {
  let rootStat
  try {
    rootStat = fs.lstatSync(hostRoot)
  } catch (cause) {
    throw syncPathError(`sync host root is unavailable: ${hostRoot}`, hostRoot)
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw syncPathError(`sync host root is no longer a directory: ${hostRoot}`, hostRoot)
  }
  const relation = path.relative(hostRoot, target)
  if (relation === '' || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw syncPathError(`sync target escapes host root: ${target}`, target)
  }
  let current = hostRoot
  for (const part of relation.split(path.sep)) {
    current = path.join(current, part)
    let stats
    try {
      stats = fs.lstatSync(current)
    } catch (cause) {
      if (cause && cause.code === 'ENOENT') return false
      throw syncPathError(`sync path is not accessible: ${current}`, current)
    }
    if (stats.isSymbolicLink()) {
      throw syncPathError(`sync path contains a symlink: ${current}`, current)
    }
  }
  return true
}

function assertSyncContained (hostRoot, target, allowRoot = false) {
  hostPath.assertContained(hostRoot, target, { allowRoot })
}

function assertSyncTarget (hostRoot, target) {
  return hostPath.assertHostTarget(hostRoot, target, { allowMissing: true })
}

function syncOneMount (mount, budget, onProgress = null) {
  const root = normalizeGuestPath(mount.guestPath)
  if (root === null) throw new Error(`invalid sync mount: ${mount.guestPath}`)
  const hostRoot = mount.hostRoot
  if (!hostRoot) throw new Error(`sync mount has no host root: ${mount.guestPath}`)
  const report = (event) => {
    if (!onProgress) return
    try {
      onProgress(event)
    } catch {
      // Progress is diagnostics; a failed progress post must not fail the sync.
    }
  }
  const baseline = mount.syncedManifest instanceof Map
    ? mount.syncedManifest
    : new Map((mount.manifest || [])
        .filter((entry) => !entry.directory)
        .map((entry) => [entry.path, entry]))
  const initial = new Map(baseline)
  const next = new Map(baseline)
  report({ phase: 'start', mount: { guestPath: root, files: baseline.size } })
  const current = new Map()
  const walk = (guestPath) => {
    for (const name of m.FS.readdir(guestPath)) {
      if (name === '.' || name === '..') continue
      const child = `${guestPath}/${name}`
      const stats = m.FS.stat(child)
      if (m.FS.isDir(stats.mode)) {
        walk(child)
      } else if (m.FS.isFile(stats.mode)) {
        budget.files += 1
        budget.bytes += stats.size
        if (stats.size > MOUNT_SYNC_LIMITS.maxFileBytes) {
          throw syncLimitError(`sync file exceeds per-file limit: ${child}`, child, MOUNT_SYNC_LIMITS.maxFileBytes, stats.size)
        }
        if (budget.files > MOUNT_SYNC_LIMITS.maxFiles) {
          throw syncLimitError('sync files exceed limit', child, MOUNT_SYNC_LIMITS.maxFiles, budget.files)
        }
        if (budget.bytes > MOUNT_SYNC_LIMITS.maxTotalBytes) {
          throw syncLimitError('sync bytes exceed limit', child, MOUNT_SYNC_LIMITS.maxTotalBytes, budget.bytes)
        }
        current.set(child, Buffer.from(m.FS.readFile(child)))
      }
    }
  }
  walk(root)
  const result = { guestPath: root, written: 0, deleted: 0, unchanged: 0, errors: [] }
  const writeAtomic = (target, content) => {
    assertSyncTarget(hostRoot, target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const parentInfo = hostPath.assertHostTarget(hostRoot, path.dirname(target), {
      allowRoot: true,
      allowMissing: false,
    })
    assertSyncPath(hostRoot, target)
    let mode = 0o666 & ~process.umask()
    try {
      const currentTarget = fs.lstatSync(target)
      if (currentTarget.isDirectory()) throw syncPathError(`sync target is a directory: ${target}`, target)
      if (!currentTarget.isFile()) throw syncPathError(`sync target is not a file: ${target}`, target)
      mode = currentTarget.mode & 0o777
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const temp = path.join(parentInfo.real, `.dsh-sync-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`)
    fs.writeFileSync(temp, content, { mode })
    try {
      assertSyncTarget(hostRoot, target)
      assertSyncPath(hostRoot, target)
      fs.renameSync(temp, target)
    } catch (error) {
      // Never fall back on a containment failure: the target may have moved
      // between the check and the rename. Only a genuine replace failure may
      // use the backup+restore path.
      try {
        assertSyncTarget(hostRoot, target)
        assertSyncPath(hostRoot, target)
      } catch (checkError) {
        fs.rmSync(temp, { force: true })
        throw checkError
      }
      let backup = null
      try {
        backup = path.join(parentInfo.real, `.dsh-sync-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`)
        fs.renameSync(target, backup)
        try {
          fs.renameSync(temp, target)
          fs.rmSync(backup, { force: true })
        } catch (renameError) {
          try {
            fs.renameSync(backup, target)
          } catch (restoreError) {
            restoreError.backup = backup
            throw restoreError
          }
          throw renameError
        }
      } catch (fallbackError) {
        fs.rmSync(temp, { force: true })
        throw fallbackError
      }
    }
    hostPath.assertHostTarget(hostRoot, target, { allowMissing: false })
  }
  for (const [guestPath, content] of current) {
    const relativePath = guestPath.slice(root.length + 1)
    const target = path.resolve(hostRoot, ...relativePath.split('/'))
    try {
      assertSyncContained(hostRoot, target)
    } catch {
      result.errors.push({ path: guestPath, code: 'E-MOUNT-SYNC-PATH' })
      report({ phase: 'file', mount: root, path: guestPath, action: 'error', code: 'E-MOUNT-SYNC-PATH' })
      continue
    }
    const before = initial.get(guestPath)
    const digest = crypto.createHash('sha256').update(content).digest('hex')
    if (before && before.sha256 === digest && before.size === content.length) {
      result.unchanged += 1
      next.set(guestPath, { path: guestPath, size: content.length, sha256: digest })
      report({ phase: 'file', mount: root, path: guestPath, action: 'unchanged' })
      continue
    }
    try {
      writeAtomic(target, content)
      result.written += 1
      next.set(guestPath, { path: guestPath, size: content.length, sha256: digest })
      report({ phase: 'file', mount: root, path: guestPath, action: 'written' })
    } catch (error) {
      result.errors.push({ path: guestPath, code: error.code || 'E-MOUNT-SYNC', message: error.message })
      report({
        phase: 'file',
        mount: root,
        path: guestPath,
        action: 'error',
        code: error.code || 'E-MOUNT-SYNC',
        message: error.message,
      })
    }
  }
  for (const guestPath of initial.keys()) {
    if (current.has(guestPath)) continue
    const relativePath = guestPath.slice(root.length + 1)
    const target = path.resolve(hostRoot, ...relativePath.split('/'))
    try {
      assertSyncContained(hostRoot, target)
    } catch {
      result.errors.push({ path: guestPath, code: 'E-MOUNT-SYNC-PATH' })
      report({ phase: 'file', mount: root, path: guestPath, action: 'error', code: 'E-MOUNT-SYNC-PATH' })
      continue
    }
    try {
      if (!assertSyncPath(hostRoot, target)) {
        next.delete(guestPath)
        continue
      }
      hostPath.assertHostTarget(hostRoot, path.dirname(target), {
        allowRoot: true,
        allowMissing: false,
      })
      fs.rmSync(target, { force: true })
      hostPath.assertHostTarget(hostRoot, path.dirname(target), {
        allowRoot: true,
        allowMissing: false,
      })
      result.deleted += 1
      next.delete(guestPath)
      report({ phase: 'file', mount: root, path: guestPath, action: 'deleted' })
    } catch (error) {
      result.errors.push({ path: guestPath, code: error.code || 'E-MOUNT-SYNC', message: error.message })
      report({
        phase: 'file',
        mount: root,
        path: guestPath,
        action: 'error',
        code: error.code || 'E-MOUNT-SYNC',
        message: error.message,
      })
    }
  }
  mount.syncedManifest = next
  return result
}

function syncMounts (onProgress = null) {
  const results = []
  const budget = { files: 0, bytes: 0 }
  for (const mount of workerData?.mountModes || []) {
    if (mount.sync !== 'on-close') continue
    results.push(syncOneMount(mount, budget, onProgress))
  }
  return { mounts: results }
}

function post (message) {
  parentPort.postMessage(message)
}

function run () {
  const channelSuffix = crypto.randomBytes(16).toString('hex')
  m.onRuntimeInitialized = () => {
    try {
      if (workerData?.guestFile) {
        const rc = cstring(workerData.guestFile, (pathPtr) => m._dsh_set_guest(pathPtr))
        if (rc !== 0) throw new Error(`dsh_set_guest rc=${rc}`)
      }
      for (const file of workerData?.projectFiles || []) mountProjectFile(file)
      for (const dir of workerData?.mountDirs || []) {
        const guestPath = normalizeGuestPath(dir)
        if (guestPath === null) throw new Error(`invalid mount directory: ${dir}`)
        if (m.FS) m.FS.mkdirTree(guestPath)
      }
      for (const file of workerData?.mountFiles || []) mountFile(file)
      if (m.FS) {
        m.FS.mkdirTree('/project')
        m.FS.mkdirTree('/out')
      }
      patchGuestChannelSuffix(channelSuffix)
      installBridgeDevices(channelSuffix)
      installReadOnlyProjectGuard(workerData?.mountModes || [])
      const rc = m._dsh_init()
      if (rc !== 0) throw new Error(`dsh_init rc=${rc}`)
      post({
        type: 'loaded',
        memory: { rss: process.memoryUsage().rss, wasmBytes: m.HEAPU8.length },
      })
      if (workerData?.probeFsLinks) {
        const results = {}
        for (const [name, args] of [
          ['symlink', ['/project/a', '/project/b']],
          ['link', ['/project/a', '/project/b']],
          ['rename', ['/project/a', '/out/b']],
          ['rename', ['/out/a', '/project/b']],
        ]) {
          try {
            if (typeof m.FS[name] !== 'function') {
              results[`${name}:${args.join('->')}`] = 'not-implemented'
              continue
            }
            m.FS[name](...args)
            results[`${name}:${args.join('->')}`] = 'allowed'
          } catch (error) {
            results[`${name}:${args.join('->')}`] = error && error.errno ? error.errno : String(error)
          }
        }
        post({ type: 'fs-link-probe', results })
      }
    } catch (error) {
      post({ type: 'error', message: error && error.stack ? error.stack : String(error), stderr: stderrText })
      return
    }

    parentPort.on('message', (message) => {
      if (message.type === 'sync-mounts') {
        try {
          post({
            type: 'sync-result',
            id: message.id,
            result: syncMounts((progress) => post({ type: 'sync-progress', id: message.id, progress })),
          })
        } catch (error) {
          post({ type: 'sync-result', id: message.id, error: error.code || 'E-MOUNT-SYNC', message: String(error && error.message ? error.message : error) })
        }
        return
      }
      if (message.type !== 'dispatch' && message.type !== 'resume') return
      try {
        const text = message.type === 'resume'
          ? resume(message.payload)
          : dispatch(message.payload)
        post({
          type: 'response',
          requestType: message.type,
          id: message.id,
          text,
          outSize: m._dsh_out_size(),
          outCount: m._dsh_out_count(),
          memory: {
            rss: process.memoryUsage().rss,
            wasmBytes: m.HEAPU8.length,
          },
        })
      } catch (error) {
        if (error && typeof error.status === 'number') {
          exitStatus = error.status
          post({ type: 'exit', code: error.status, stderr: stderrText.slice(-4000) })
        } else {
          post({
            type: 'error',
            id: message.id,
            code: error && error.code ? error.code : null,
            message: error && error.stack ? error.stack : String(error),
            stderr: stderrText.slice(-4000),
          })
          if (error && typeof error.code === 'string' && error.code.startsWith('E-OUTPUT-')) {
            process.exit(70)
          }
        }
      }
    })
  }

  const glue = fs.readFileSync(path.join(asset, 'scheme-c.js'), 'utf8')
  const code = glue.replace(/^var Module=/, 'var Module=globalThis.__dshModule; var __wasmModuleOriginal=')
  globalThis.__dshModule = m
  try {
    new Function('require', '__dirname', '__filename', 'process', 'Buffer', 'setTimeout', 'clearTimeout', code)(
      require,
      asset,
      path.join(asset, 'scheme-c.js'),
      process,
      Buffer,
      setTimeout,
      clearTimeout,
    )
  } catch (error) {
    post({ type: 'error', message: error && error.stack ? error.stack : String(error), stderr: stderrText })
  }
}

run()
