import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SYNC_PROGRESS_MAX_ERRORS,
  SYNC_PROGRESS_MAX_PATHS,
  applySyncProgress,
  createSyncProgress,
  snapshotSyncProgress,
} from '../lib/rules/scheme/v2/sync-progress.js'

test('sync progress aggregates mounts and produces a partial snapshot', () => {
  const state = createSyncProgress(1000)
  applySyncProgress(state, { phase: 'start', mount: { guestPath: '/mnt/a', files: 3 } })
  applySyncProgress(state, { phase: 'file', action: 'written', mount: '/mnt/a', path: '/mnt/a/out.txt' })
  applySyncProgress(state, { phase: 'file', action: 'unchanged', mount: '/mnt/a', path: '/mnt/a/data.txt' })
  applySyncProgress(state, { phase: 'file', action: 'deleted', mount: '/mnt/a', path: '/mnt/a/old.txt' })
  applySyncProgress(state, {
    phase: 'file',
    action: 'error',
    mount: '/mnt/a',
    path: '/mnt/a/bad.txt',
    code: 'EACCES',
    message: 'denied',
  })

  const snapshot = snapshotSyncProgress(state, 'timeout')
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.reason, 'timeout')
  assert.equal(snapshot.truncated, false)
  assert.equal(snapshot.mounts.length, 1)
  assert.deepEqual(snapshot.mounts[0], {
    guestPath: '/mnt/a',
    written: 1,
    deleted: 1,
    unchanged: 1,
    files: 3,
    errors: [{ path: '/mnt/a/bad.txt', code: 'EACCES', message: 'denied' }],
    writtenPaths: ['/mnt/a/out.txt'],
    deletedPaths: ['/mnt/a/old.txt'],
    truncated: false,
  })
})

test('sync progress caps stored paths and errors', () => {
  const state = createSyncProgress(1000)
  for (let i = 0; i < SYNC_PROGRESS_MAX_PATHS + 1; i += 1) {
    applySyncProgress(state, {
      phase: 'file',
      action: 'written',
      mount: '/mnt/a',
      path: `/mnt/a/${i}.txt`,
    })
  }
  for (let i = 0; i < SYNC_PROGRESS_MAX_ERRORS + 1; i += 1) {
    applySyncProgress(state, {
      phase: 'file',
      action: 'error',
      mount: '/mnt/a',
      path: `/mnt/a/${i}.txt`,
      code: 'EACCES',
    })
  }

  const snapshot = snapshotSyncProgress(state, 'timeout')
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.mounts[0].written, SYNC_PROGRESS_MAX_PATHS + 1)
  assert.equal(snapshot.mounts[0].writtenPaths.length, SYNC_PROGRESS_MAX_PATHS)
  assert.equal(snapshot.mounts[0].errors.length, SYNC_PROGRESS_MAX_ERRORS)
  assert.equal(snapshot.mounts[0].truncated, true)
  assert.equal(snapshotSyncProgress(state, 'E-MOUNT-SYNC').reason, 'error')
})
