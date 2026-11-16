import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SchemeV2Runtime, buildSchemeV2Pin } from '../lib/rules/index.js'
import { readMounts } from '../lib/rules/scheme/v2/mount-lib.js'

const readRule = [
  '(library (dsh rule mount.read (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (rnrs io ports (6)) (rnrs bytevectors (6)))',
  '  (define (entry)',
  '    (let ([p (open-file-input-port "/mnt/input/data.txt")])',
  '      (let ([body (get-bytevector-all p)])',
  '        (close-port p)',
  '        (utf8->string body)))))',
  '',
].join('\n')

const writeRule = [
  '(library (dsh rule mount.write (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (rnrs io ports (6)) (rnrs bytevectors (6)))',
  '  (define (entry)',
  '    (let ([p (open-file-output-port "/mnt/input/out.txt" (file-options no-fail) (buffer-mode none))])',
  '      (put-bytevector p (string->utf8 "written"))',
  '      (close-port p))',
  '    (let ([p (open-file-input-port "/mnt/input/out.txt")])',
  '      (let ([body (get-bytevector-all p)])',
  '        (close-port p)',
  '        (utf8->string body)))))',
  '',
].join('\n')

const oversizeRule = [
  '(library (dsh rule mount.oversize (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (rnrs io ports (6)) (rnrs bytevectors (6)))',
  '  (define (entry)',
  '    (let ([p (open-file-output-port "/mnt/input/big.bin" (file-options no-fail) (buffer-mode none))])',
  '      (put-bytevector p (make-bytevector (+ (* 8 1024 1024) 1) 65))',
  '      (close-port p))',
  '    #t))',
  '',
].join('\n')

const deleteRule = [
  '(library (dsh rule mount.delete (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (rnrs files (6)))',
  '  (define (entry) (delete-file "/mnt/input/data.txt") #t))',
  '',
].join('\n')

const manyRule = [
  '(library (dsh rule mount.many (1 0 0))',
  '  (export entry)',
  '  (import (rnrs base (6)) (rnrs io ports (6)) (rnrs bytevectors (6)))',
  '  (define (fill-from dir i)',
  '    (if (< i 1025)',
  '        (let ([p (open-file-output-port (string-append dir "/f-" (number->string i) ".txt")',
  '                                        (file-options no-fail) (buffer-mode none))])',
  '          (put-bytevector p (string->utf8 "x"))',
  '          (close-port p)',
  '          (fill-from dir (+ i 1)))',
  '        #f))',
  '  (define (fill dir) (fill-from dir 0))',
  '  (define (entry) (fill "/mnt/a") (fill "/mnt/b") #t))',
  '',
].join('\n')

async function makePin () {
  return buildSchemeV2Pin({
    project: 'mount-test',
    rules: [
      { id: 'mount.read', version: [1, 0, 0], source: readRule },
      { id: 'mount.write', version: [1, 0, 0], source: writeRule },
      { id: 'mount.oversize', version: [1, 0, 0], source: oversizeRule },
      { id: 'mount.delete', version: [1, 0, 0], source: deleteRule },
    ],
  })
}

async function makeManyPin () {
  return buildSchemeV2Pin({
    project: 'mount-many-test',
    rules: [{ id: 'mount.many', version: [1, 0, 0], source: manyRule }],
  })
}

test('mounts are readable by Scheme without exposing host writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'hello')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'r-x' }],
  })
  try {
    assert.equal(await runtime.call('mount.read'), 'hello')
    assert.equal(runtime.mounts.length, 1)
    assert.equal(runtime.mounts[0].guestPath, '/mnt/input')
    assert.equal(runtime.mounts[0].mode, 'r-x')
    assert.match(runtime.mounts[0].manifestHash, /^sha256:[0-9a-f]{64}$/)
    await assert.rejects(
      runtime.call('mount.write'),
      (error) => error.code === 'E-RULE-ERROR',
    )
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rwx mounts write inside MEMFS but not back to the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'hello')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx' }],
  })
  try {
    assert.equal(await runtime.call('mount.write'), 'written')
    assert.deepEqual(await readdir(input), ['data.txt'])
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('mode without execute cannot traverse the mount', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'hello')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'r--' }],
  })
  await assert.rejects(runtime.call('mount.read'))
  await runtime.close()
  await rm(root, { recursive: true, force: true })
})

test('mount configuration rejects reserved paths and host escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  await mkdir(join(root, 'input'))
  const pin = await makePin()
  try {
    await assert.rejects(
      SchemeV2Runtime.open(pin, { projectRoot: root, mounts: [{ hostPath: 'input', guestPath: '/project/input' }] }),
      (error) => error.code === 'E-MOUNT-OVERLAP',
    )
    await assert.rejects(
      SchemeV2Runtime.open(pin, { projectRoot: root, mounts: [{ hostPath: '..', guestPath: '/mnt/input' }] }),
      (error) => ['E-MOUNT-SOURCE', 'E-MOUNT-CONFIG'].includes(error.code),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mounts keep the open-time snapshot until the runtime is closed and reopened', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'before')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input' }],
  })
  await writeFile(join(input, 'data.txt'), 'after')
  assert.equal(await runtime.call('mount.read'), 'before')
  await runtime.close()
  const reopened = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input' }],
  })
  assert.equal(await reopened.call('mount.read'), 'after')
  await reopened.close()
  await rm(root, { recursive: true, force: true })
})

test('sync none keeps host unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'hello')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx', sync: 'none' }],
  })
  assert.equal(await runtime.call('mount.write'), 'written')
  await runtime.close()
  assert.equal(await readFile(join(input, 'data.txt'), 'utf8'), 'hello')
  assert.equal(runtime.syncResult, null)
  await rm(root, { recursive: true, force: true })
})

test('sync mounts write MEMFS changes back to the host on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'hello')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx', sync: 'on-close' }],
  })
  assert.equal(await runtime.call('mount.write'), 'written')
  assert.deepEqual(await readdir(input), ['data.txt'])
  await runtime.close()
  assert.deepEqual(await readdir(input), ['data.txt', 'out.txt'])
  assert.equal(await readFile(join(input, 'out.txt'), 'utf8'), 'written')
  assert.equal(runtime.syncResult.mounts[0].written, 1)
  await rm(root, { recursive: true, force: true })
})

test('supervised sync mounts write back on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'hello')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    supervised: true,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx', sync: 'on-close' }],
  })
  assert.equal(await runtime.call('mount.write'), 'written')
  await runtime.close()
  assert.equal(await readFile(join(input, 'out.txt'), 'utf8'), 'written')
  await rm(root, { recursive: true, force: true })
})

test('sync mounts delete host files removed in MEMFS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'data.txt'), 'hello')
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx', sync: 'on-close' }],
  })
  assert.equal(await runtime.call('mount.delete'), true)
  await runtime.close()
  assert.deepEqual(await readdir(input), [])
  assert.equal(runtime.syncResult.mounts[0].deleted, 1)
  await rm(root, { recursive: true, force: true })
})

test('close rejects when a sync target cannot be replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx', sync: 'on-close' }],
  })
  assert.equal(await runtime.call('mount.write'), 'written')
  await mkdir(join(input, 'out.txt'))
  await assert.rejects(runtime.close(), (error) => error.code === 'E-MOUNT-SYNC')
  assert.equal(runtime.syncResult.mounts[0].errors.length, 1)
  assert.equal(runtime.closed, true)
  await rm(root, { recursive: true, force: true })
})

test('sync rejects a MEMFS file larger than the per-file limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx', sync: 'on-close' }],
  })
  assert.equal(await runtime.call('mount.oversize'), true)
  await assert.rejects(runtime.close(), (error) => error.code === 'E-MOUNT-LIMIT')
  assert.equal(runtime.syncResult, null)
  await rm(root, { recursive: true, force: true })
})

test('mount limits are aggregate across mounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const inputA = join(root, 'a')
  const inputB = join(root, 'b')
  await mkdir(inputA)
  await mkdir(inputB)
  await Promise.all(Array.from({ length: 1025 }, (_, index) =>
    writeFile(join(inputA, `a-${index}.txt`), '')))
  await Promise.all(Array.from({ length: 1025 }, (_, index) =>
    writeFile(join(inputB, `b-${index}.txt`), '')))
  assert.throws(
    () => readMounts(root, [
      { hostPath: 'a', guestPath: '/mnt/a' },
      { hostPath: 'b', guestPath: '/mnt/b' },
    ]),
    (error) => error.code === 'E-MOUNT-LIMIT',
  )
  await rm(root, { recursive: true, force: true })
})

test('sync limits are aggregate across mounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const inputA = join(root, 'a')
  const inputB = join(root, 'b')
  await mkdir(inputA)
  await mkdir(inputB)
  const pin = await makeManyPin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    mounts: [
      { hostPath: 'a', guestPath: '/mnt/a', mode: 'rwx', sync: 'on-close' },
      { hostPath: 'b', guestPath: '/mnt/b', mode: 'rwx', sync: 'on-close' },
    ],
  })
  try {
    assert.equal(await runtime.call('mount.many'), true)
    await assert.rejects(runtime.close(), (error) => error.code === 'E-MOUNT-LIMIT')
    assert.equal(runtime.syncResult, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('supervised mount-level sync errors reject with the real code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const input = join(root, 'input')
  await mkdir(input)
  const pin = await makePin()
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: root,
    supervised: true,
    mounts: [{ hostPath: 'input', guestPath: '/mnt/input', mode: 'rwx', sync: 'on-close' }],
  })
  try {
    assert.equal(await runtime.call('mount.oversize'), true)
    await assert.rejects(runtime.close(), (error) => error.code === 'E-MOUNT-LIMIT')
    assert.equal(runtime.syncResult, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
