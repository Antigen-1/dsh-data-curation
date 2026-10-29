import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, readLock, withProjectLock } from '../lib/lock.js'
import { createStore } from '../lib/store.js'

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-lock-'))
  const store = createStore(root, '.curation')
  return { root, store, lockPath: join(store.dir, 'lock') }
}

async function putLock(path, extra) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify({
    op: 'compare',
    owner: 'someone-else',
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  })}\n`, 'utf8')
}

test('同一项目第二个操作被拒绝', async () => {
  const { root, store } = await makeStore()
  const first = await acquireLock(store, { op: 'compare' })
  await assert.rejects(() => acquireLock(store, { op: 'apply' }), /项目正被占用：compare/)
  await first.release()
  const second = await acquireLock(store, { op: 'apply' })
  assert.equal(second.info.op, 'apply')
  await second.release()
  await rm(root, { recursive: true, force: true })
})

test('释放只删自己的锁', async () => {
  const { root, store, lockPath } = await makeStore()
  const lock = await acquireLock(store, { op: 'compare' })
  // 模拟：锁文件被另一个持锁者接管（owner 变了）
  await putLock(lockPath, { owner: 'other-owner' })
  await lock.release()
  const still = JSON.parse(await readFile(lockPath, 'utf8'))
  assert.equal(still.owner, 'other-owner')
  await rm(root, { recursive: true, force: true })
})

test('过期租约可以被抢占', async () => {
  const { root, store, lockPath } = await makeStore()
  await putLock(lockPath, { expiresAt: new Date(Date.now() - 1000).toISOString() })
  const lock = await acquireLock(store, { op: 'apply' })
  assert.equal(lock.info.op, 'apply')
  await lock.release()
  await rm(root, { recursive: true, force: true })
})

test('同一台机器上进程已退出的锁立即失效', async () => {
  const { root, store, lockPath } = await makeStore()
  // 起一个立刻退出的子进程，拿它的 pid（现在肯定不存在了）
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.equal(child.status, 0)
  await putLock(lockPath, { pid: child.pid })
  const lock = await acquireLock(store, { op: 'apply' })
  assert.equal(lock.info.op, 'apply')
  await lock.release()
  await rm(root, { recursive: true, force: true })
})

test('别的主机的锁不会因为 pid 判定被抢占（等租约）', async () => {
  const { root, store, lockPath } = await makeStore()
  await putLock(lockPath, { host: 'some-other-host' })
  await assert.rejects(() => acquireLock(store, { op: 'apply' }), /项目正被占用/)
  await rm(root, { recursive: true, force: true })
})

test('withProjectLock 在抛错时也释放', async () => {
  const { root, store } = await makeStore()
  await assert.rejects(
    () => withProjectLock(store, 'pack', async () => { throw new Error('boom') }),
    /boom/,
  )
  assert.equal(await readLock(store), null)
  const again = await acquireLock(store, { op: 'verify' })
  await again.release()
  await rm(root, { recursive: true, force: true })
})

test('curation_status 能看到锁的持有者', async () => {
  const { root, store } = await makeStore()
  const lock = await acquireLock(store, { op: 'compare' })
  const seen = await readLock(store)
  assert.equal(seen.op, 'compare')
  assert.equal(seen.stale, false)
  await lock.release()
  assert.equal(await readLock(store), null)
  await rm(root, { recursive: true, force: true })
})
