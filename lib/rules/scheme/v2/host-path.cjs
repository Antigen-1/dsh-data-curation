'use strict'

// Host path containment helpers shared by the mount reader (ESM) and the
// worker sync writer (CJS). These checks are best-effort: Node has no
// openat/renameat2, so a concurrent writer can still race a path after the
// final check. The mount contract treats the host directory as trusted.

const fs = require('node:fs')
const path = require('node:path')

function pathError (message, target) {
  const error = new Error(message)
  error.code = 'E-MOUNT-SYNC-PATH'
  error.target = target
  return error
}

function isContained (root, target, { allowRoot = false } = {}) {
  const relation = path.relative(root, target)
  if (relation === '') return allowRoot
  return relation !== '..' &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
}

function assertContained (root, target, options = {}) {
  if (!isContained(root, target, options)) {
    throw pathError(`path escapes mount root: ${target}`, target)
  }
}

function nearestExistingAncestor (target) {
  let current = target
  for (;;) {
    try {
      fs.lstatSync(current)
      return current
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

function assertHostTarget (root, target, { allowRoot = false, allowMissing = true } = {}) {
  assertContained(root, target, { allowRoot })
  let ancestor
  try {
    ancestor = nearestExistingAncestor(target)
  } catch (error) {
    throw pathError(`host path is not accessible: ${target}`, target)
  }
  let stats
  try {
    stats = fs.lstatSync(ancestor)
  } catch {
    throw pathError(`host path is not accessible: ${target}`, target)
  }
  const targetExists = ancestor === target
  if (!allowMissing && !targetExists) {
    throw pathError(`host path does not exist: ${target}`, target)
  }
  if (!stats.isDirectory() && !targetExists) {
    throw pathError(`host path ancestor is not a directory: ${ancestor}`, target)
  }
  let real
  try {
    real = fs.realpathSync(ancestor)
  } catch {
    throw pathError(`host path is not accessible: ${target}`, target)
  }
  assertContained(root, real, { allowRoot: true })
  return { ancestor, real }
}

module.exports = {
  assertContained,
  assertHostTarget,
  isContained,
  pathError,
}
