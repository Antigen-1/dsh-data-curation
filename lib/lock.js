// lib/lock.js — one mutating operation per project at a time.
//
// SQLite already makes a single transaction atomic, but several operations
// read → compute → write across more than one statement (and some spawn an
// external command), so two sessions could interleave and produce a decision
// table that mixes two runs. This is a cooperative lock for that window:
//
//   .curation/lock   JSON: {op, owner, pid, host, startedAt, expiresAt}
//
// Properties that matter here:
// - acquired with O_EXCL (fs.open 'wx'), so creation is atomic on one host;
// - a lease (`ttlMs`) bounds locks left behind by a crash;
// - on the same host a lock whose pid is gone is stale immediately, so a
//   crashed session does not block the next one for the whole TTL;
// - stealing is done by rename(), so two stealers cannot both win;
// - release only removes our own lock (owner token match).
import { promises as fs } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { ensureDir, nowIso } from './util.js'

export const DEFAULT_TTL_MS = 10 * 60 * 1000

const host = () => hostname()

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return e?.code === 'EPERM'
  }
}

async function readLockFile(path) {
  try {
    const text = await fs.readFile(path, 'utf8')
    const info = JSON.parse(text)
    return info && typeof info === 'object' ? info : null
  } catch {
    return null
  }
}

function describe(info, rel) {
  if (!info) return `另一个操作正持有项目锁（无法读取 ${rel} 的内容）`
  const who = `${info.op ?? '未知操作'}（pid ${info.pid ?? '?'} @ ${info.host ?? '?'}）`
  return `项目正被占用：${who}，开始于 ${info.startedAt ?? '?'}，租约至 ${info.expiresAt ?? '?'}；`
    + `确认没有其他会话在跑后，可等待租约过期，或手工删除 ${rel}`
}

function staleReason(info, now) {
  if (!info) return 'unreadable'
  const expires = Date.parse(info.expiresAt ?? '')
  if (Number.isFinite(expires) && expires <= now) return 'expired'
  if (info.host === host() && !pidAlive(info.pid)) return 'process-gone'
  return null
}

/**
 * Acquire the project lock.
 * @param {{dir:string, cwd:string}} store
 * @param {{op?:string, ttlMs?:number, owner?:string}} [options]
 */
export async function acquireLock(store, { op = 'operation', ttlMs = DEFAULT_TTL_MS, owner = null } = {}) {
  await ensureDir(store.dir)
  const lockPath = join(store.dir, 'lock')
  const rel = '.curation/lock'
  const token = owner ?? `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const info = {
    op,
    owner: token,
    pid: process.pid,
    host: host(),
    startedAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fh = await fs.open(lockPath, 'wx')
      try {
        await fh.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      return makeHandle(lockPath, token, info, null)
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }

    const prev = await readLockFile(lockPath)
    const reason = staleReason(prev, Date.now())
    if (!reason) {
      const error = new Error(describe(prev, rel))
      error.code = 'CURATION_LOCKED'
      error.holder = prev ?? null
      throw error
    }

    // Steal through rename: whoever renames first owns the tombstone, the other
    // sees ENOENT and re-reads (the winner may already hold the new lock).
    const tomb = `${lockPath}.stale-${process.pid}-${Date.now()}`
    try {
      await fs.rename(lockPath, tomb)
    } catch (e) {
      if (e?.code === 'ENOENT') continue
      throw e
    }
    await fs.rm(tomb, { force: true })
    // retry the loop and compete for a fresh lock
  }
  const error = new Error(`无法获取项目锁：${rel} 连续抢占失败，请检查是否有其他会话在运行`)
  error.code = 'CURATION_LOCKED'
  throw error
}

function makeHandle(lockPath, token, info, stolen) {
  let released = false
  return {
    path: lockPath,
    info,
    stolen,
    async release() {
      if (released) return
      released = true
      const current = await readLockFile(lockPath)
      if (current?.owner !== token) return // someone else's lock: leave it alone
      await fs.rm(lockPath, { force: true })
    },
    /** Still ours and not expired? Used by long operations that check in. */
    async renew(ttlMs = DEFAULT_TTL_MS) {
      const current = await readLockFile(lockPath)
      if (current?.owner !== token) return false
      current.expiresAt = new Date(Date.now() + ttlMs).toISOString()
      const fh = await fs.open(lockPath, 'w')
      try {
        await fh.writeFile(`${JSON.stringify(current, null, 2)}\n`, 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      return true
    },
  }
}

/** Run fn while holding the project lock; always releases. */
export async function withProjectLock(store, op, fn, { ttlMs } = {}) {
  const lock = await acquireLock(store, { op, ttlMs })
  try {
    return await fn(lock)
  } finally {
    await lock.release()
  }
}

/** Current lock holder, if any (read-only; used by curation_status). */
export async function readLock(store) {
  const info = await readLockFile(join(store.dir, 'lock'))
  if (!info) return null
  const reason = staleReason(info, Date.now())
  return { ...info, stale: Boolean(reason), staleReason: reason }
}
