export const SYNC_PROGRESS_MAX_PATHS = 2048
export const SYNC_PROGRESS_MAX_ERRORS = 256

export function createSyncProgress (now = Date.now()) {
  return {
    startedAt: now,
    at: now,
    mounts: new Map(),
    paths: 0,
    truncated: false,
  }
}

function mountState (state, guestPath) {
  const key = typeof guestPath === 'string' ? guestPath : String(guestPath ?? '')
  let mount = state.mounts.get(key)
  if (!mount) {
    mount = {
      guestPath: key,
      written: 0,
      deleted: 0,
      unchanged: 0,
      errors: [],
      writtenPaths: [],
      deletedPaths: [],
      truncated: false,
    }
    state.mounts.set(key, mount)
  }
  return mount
}

function addPath (state, mount, list, value) {
  if (state.paths >= SYNC_PROGRESS_MAX_PATHS) {
    state.truncated = true
    mount.truncated = true
    return
  }
  state.paths += 1
  list.push(value)
}

export function applySyncProgress (state, event) {
  if (!state || !event || typeof event !== 'object') return state
  state.at = Date.now()
  if (event.phase === 'start') {
    const mount = mountState(state, event.mount?.guestPath)
    if (Number.isInteger(event.mount?.files)) mount.files = event.mount.files
    return state
  }
  if (event.phase !== 'file') return state
  const mount = mountState(state, event.mount ?? event.guestPath)
  const guestPath = typeof event.path === 'string' ? event.path : ''
  switch (event.action) {
    case 'written':
      mount.written += 1
      addPath(state, mount, mount.writtenPaths, guestPath)
      break
    case 'deleted':
      mount.deleted += 1
      addPath(state, mount, mount.deletedPaths, guestPath)
      break
    case 'unchanged':
      mount.unchanged += 1
      break
    case 'error':
      if (mount.errors.length < SYNC_PROGRESS_MAX_ERRORS) {
        mount.errors.push({
          path: guestPath,
          code: event.code || 'E-MOUNT-SYNC',
          ...(event.message ? { message: event.message } : {}),
        })
      } else {
        state.truncated = true
        mount.truncated = true
      }
      break
    default:
      break
  }
  return state
}

export function snapshotSyncProgress (state, reason = 'timeout') {
  const mounts = []
  for (const mount of state?.mounts?.values?.() ?? []) {
    mounts.push({
      guestPath: mount.guestPath,
      written: mount.written,
      deleted: mount.deleted,
      unchanged: mount.unchanged,
      errors: mount.errors.map((error) => ({ ...error })),
      writtenPaths: mount.writtenPaths.slice(),
      deletedPaths: mount.deletedPaths.slice(),
      ...(mount.files !== undefined ? { files: mount.files } : {}),
      truncated: mount.truncated,
    })
  }
  return {
    startedAt: state?.startedAt ?? null,
    at: state?.at ?? Date.now(),
    complete: false,
    reason,
    truncated: Boolean(state?.truncated),
    mounts,
  }
}
