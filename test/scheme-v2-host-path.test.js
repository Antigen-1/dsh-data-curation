import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import hostPath from '../lib/rules/scheme/v2/host-path.cjs'

test('host path accepts an existing file and a contained symlink target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-path-'))
  try {
    const inside = join(root, 'inside.txt')
    await writeFile(inside, 'inside')
    const info = hostPath.assertHostTarget(root, inside, { allowMissing: false })
    assert.equal(info.ancestor, inside)
    assert.equal(hostPath.isContained(root, inside), true)
    assert.equal(hostPath.isContained(root, root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host path rejects a final symlink that leaves the mount root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-path-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-host-out-'))
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'escape'), 'junction')
    assert.throws(
      () => hostPath.assertHostTarget(root, join(root, 'escape', 'secret.txt'), { allowMissing: false }),
      (error) => error.code === 'E-MOUNT-SYNC-PATH',
    )
    assert.equal(hostPath.isContained(root, join(root, 'escape', 'secret.txt')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('host path allows a missing target below an existing contained directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-path-'))
  try {
    await mkdir(join(root, 'nested'))
    const missing = join(root, 'nested', 'new.txt')
    const info = hostPath.assertHostTarget(root, missing)
    assert.equal(info.ancestor, join(root, 'nested'))
    assert.throws(
      () => hostPath.assertHostTarget(root, missing, { allowMissing: false }),
      (error) => error.code === 'E-MOUNT-SYNC-PATH',
    )
    assert.throws(
      () => hostPath.assertHostTarget(root, join(root, '..', 'outside.txt')),
      (error) => error.code === 'E-MOUNT-SYNC-PATH',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
