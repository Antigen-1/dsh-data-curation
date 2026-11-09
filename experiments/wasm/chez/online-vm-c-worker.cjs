'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

const here = __dirname
const asset = workerData?.assetDir ? path.resolve(here, workerData.assetDir) : path.join(here, '10.4.1-c')
const MAX_OUTPUT_BYTES = 1000000
let stderrText = ''

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

function installReadOnlyProjectGuard () {
  if (!m.FS || !m.FS.open) return
  const MAX_OUT_BYTES = 65536
  const MAX_OUT_FILES = 8
  let outBytes = 0
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
    if (underOut(normalized) && (flags & 64) !== 0) {
      try {
        if (m.FS.readdir('/out').filter((name) => name !== '.' && name !== '..').length >= MAX_OUT_FILES) deny(28)
      } catch (error) {
        if (error && error.errno === 28) throw error
      }
    }
    return open.call(this, normalized, flags, mode)
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

function mountProjectFile (file) {
  const content = Buffer.from(file.content, 'utf8')
  const guestPath = normalizeGuestPath(file.path)
  if (guestPath === null || !guestPath.startsWith('/project/')) {
    throw new Error(`project file outside /project: ${file.path}`)
  }
  if (m.FS) {
    const slash = guestPath.lastIndexOf('/')
    const dir = guestPath.slice(0, slash)
    m.FS.mkdirTree(dir)
    m.FS.createDataFile(dir, guestPath.slice(slash + 1), content, true, false, false)
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

function post (message) {
  parentPort.postMessage(message)
}

function run () {
  m.onRuntimeInitialized = () => {
    try {
      if (workerData?.guestFile) {
        const rc = cstring(workerData.guestFile, (pathPtr) => m._dsh_set_guest(pathPtr))
        if (rc !== 0) throw new Error(`dsh_set_guest rc=${rc}`)
      }
      for (const file of workerData?.projectFiles || []) mountProjectFile(file)
      if (m.FS) {
        m.FS.mkdirTree('/project')
        m.FS.mkdirTree('/out')
      }
      installReadOnlyProjectGuard()
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
