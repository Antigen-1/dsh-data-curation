// lib/strategies.js — the two decisions every adjudication makes.
//
//   compare: given the channel votes for one cell, which ones agree?
//   select:  among agreeing channels, which raw spelling gets written?
//
// Both are contract policy, not code: a project can pick a built-in or hand the
// job to its own command. The hooks are deliberately two, not one, because
// "do these two readings describe the same fact" and "which of these two
// spellings should the table hold" are different questions — the ESD review
// needed synonym equivalence for some fields and exact text for others, and it
// needed to write the shortest spelling even when both agreed.
//
// Failure is always explicit: a command that exits non-zero, crashes, prints
// something that is not the documented shape, or cannot be spawned raises
// AdjudicationError. Nothing is guessed and no default strategy is silently
// substituted — the cell stays pending.
import { spawnSync } from 'node:child_process'

export const COMPARE_BUILTINS = ['exact', 'numeric', 'ordered-groups']
export const SELECT_BUILTINS = ['first-valid', 'longest', 'channel-order', 'lowest', 'highest']

export const DEFAULT_COMPARE = { builtin: 'exact' }
export const DEFAULT_SELECT = { builtin: 'first-valid' }

export class AdjudicationError extends Error {
  constructor(message, code = 'adjudicator_error') {
    super(message)
    this.name = 'AdjudicationError'
    this.code = code
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Value as written by the channel, or an empty string. */
const rawOf = (vote) => (vote.raw === null || vote.raw === undefined ? '' : String(vote.raw))

/** True when the whole spec is one external command. */
export const isCommand = (spec) => Boolean(spec && typeof spec.command === 'string')

/**
 * Pick the strategy objects for one field: field-level override, else the
 * contract-level block, else the defaults.
 */
export function resolveAdjudication(contract, field) {
  const block = contract?.adjudication
  const perField = block?.fields?.[field?.name]
  const compare = { ...DEFAULT_COMPARE, ...(block?.compare ?? {}), ...(perField?.compare ?? {}) }
  const select = { ...DEFAULT_SELECT, ...(block?.select ?? {}), ...(perField?.select ?? {}) }
  return { compare, select }
}

/** Stable label for the decision record ("exact" / "command" / …). */
export const strategyName = (spec) => (isCommand(spec) ? 'command' : (spec?.builtin ?? 'exact'))

function runStrategy(spec, kind, payload, root) {
  const timeoutMs = spec.timeoutMs ?? 60_000
  const res = spawnSync(spec.command, spec.args ?? [], {
    cwd: root,
    shell: true,
    input: JSON.stringify({ kind, ...payload }),
    env: { ...process.env, CURATION_STRATEGY: kind },
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (res.error) {
    const detail = res.error.code === 'ETIMEDOUT' ? `超过 ${timeoutMs}ms` : res.error.message
    throw new AdjudicationError(`裁定命令无法执行：${detail}`)
  }
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? '').trim().slice(0, 500)
    throw new AdjudicationError(`裁定命令退出码 ${res.status}${stderr ? `：${stderr}` : ''}`)
  }
  try {
    return JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    throw new AdjudicationError('裁定命令输出不是 JSON')
  }
}

/* ---------- compare ---------- */

/** Parse a normalized value as a single number, or null when it is not one. */
function parseNumeric(value) {
  const s = String(value ?? '').trim()
  if (!s) return null
  const m = s.replace(/\s+/g, '').match(/^(-?\d+(?:\.\d+)?)([a-z%]*)$/i)
  if (!m) return null
  const unit = m[2].toLowerCase()
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const scale = { mm: 1, cm: 10, m: 1000, '': 1 }[unit]
  if (scale === undefined) return null
  return n * scale
}

function splitOrdered(value, separator) {
  const chars = String(separator ?? '、,;|/').replace(/[\]\\^-]/g, '\\$&')
  const re = new RegExp(`[${chars}\\s]+`)
  return String(value ?? '').split(re).map((s) => s.trim()).filter(Boolean)
}

function union(classes, a, b) {
  const ia = classes.findIndex((c) => c.includes(a))
  const ib = classes.findIndex((c) => c.includes(b))
  if (ia === -1 && ib === -1) classes.push([a, b])
  else if (ia === -1) classes[ib].push(a)
  else if (ib === -1) classes[ia].push(b)
  else if (ia !== ib) classes[ia].push(...classes[ib].splice(0))
}

function compareBuiltin(spec, votes) {
  const equal = (left, right) => {
    const kind = spec?.builtin ?? 'exact'
    if (kind === 'numeric') {
      const a = parseNumeric(left.normalized)
      const b = parseNumeric(right.normalized)
      if (a === null || b === null) return left.normalized === right.normalized
      const tolerance = spec.tolerance ?? 0
      return tolerance > 0 ? Math.abs(a - b) <= tolerance : a === b
    }
    if (kind === 'ordered-groups') {
      const leftGroups = splitOrdered(left.normalized, spec.separator).sort()
      const rightGroups = splitOrdered(right.normalized, spec.separator).sort()
      if (leftGroups.length !== rightGroups.length) return false
      return leftGroups.every((s, i) => s === rightGroups[i])
    }
    return left.normalized === right.normalized
  }

  const classes = []
  for (let i = 0; i < votes.length; i += 1) {
    for (let j = i + 1; j < votes.length; j += 1) {
      if (equal(votes[i], votes[j])) union(classes, i, j)
    }
  }
  return classes.sort((a, b) => b.length - a.length)
}

/**
 * Group agreeing votes. Returns arrays of indices into `votes`, largest group
 * first. With the built-in `ordered-groups`, a group whose members describe the
 * same set of items in a different order is accepted and the members are told
 * apart by `synthesizedValue` later.
 */
export function groupVotes({ votes, spec, contract, field, recordId, root }) {
  const values = votes.map((v) => ({ channel: v.channel, raw: rawOf(v), normalized: v.normalized ?? '' }))
  if (!isCommand(spec)) return compareBuiltin(spec ?? DEFAULT_COMPARE, votes)

  const out = runStrategy(spec, 'compare', { record: recordId, field: field.name, values }, root)
  return validateGroups(out?.groups, votes)
}

/** Validate a `groups` array against the votes it indexes. */
export function validateGroups(groups, votes) {
  if (!Array.isArray(groups)) throw new AdjudicationError('裁定命令输出缺少 groups 数组')
  const seen = new Set()
  const normalized = []
  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) throw new AdjudicationError('裁定命令输出的 groups 有空组或非数组')
    const idx = []
    for (const i of group) {
      if (!Number.isInteger(i) || i < 0 || i >= votes.length) {
        throw new AdjudicationError(`裁定命令输出的下标越界：${i}`)
      }
      if (seen.has(i)) throw new AdjudicationError(`裁定命令把通道 ${votes[i].channel} 分进了多个组`)
      seen.add(i)
      idx.push(i)
    }
    normalized.push(idx)
  }
  return normalized.sort((a, b) => b.length - a.length)
}

/** True when this compare spec asked to judge a whole batch in one command. */
export function isBatchSpec(spec) {
  return Boolean(spec?.batch) && isCommand(spec)
}

/**
 * One command call for many cells:
 * stdin  { kind: 'compare-batch', cells: [{ record, field, values }] }
 * stdout { results: [{ record, field, groups }] }
 */
export function runBatchCompare({ spec, cells, root }) {
  const out = runStrategy(spec, 'compare-batch', { cells }, root)
  const results = out?.results
  if (!Array.isArray(results)) throw new AdjudicationError('批量裁定命令输出缺少 results 数组')
  return results
}

/* ---------- select ---------- */

function orderOf(spec, contract, channel) {
  if (Array.isArray(spec?.order)) {
    const at = spec.order.indexOf(channel)
    return at === -1 ? 99 : at
  }
  const declared = (contract?.channels ?? []).map((c) => c.name)
  const at = declared.indexOf(channel)
  return at === -1 ? 99 : at
}

const numericOf = (vote) => {
  const n = parseNumeric(vote.normalized)
  if (n === null) throw new AdjudicationError(`字段值不是数字，无法按数值选取：${rawOf(vote)}`, 'adjudicator_invalid')
  return n
}

/**
 * Choose the raw string to write.
 * @returns {{value:any, synthesized:boolean, reason?:string}}
 */
export function selectValue({ votes, spec, contract, field, recordId, root }) {
  const chosen = spec ?? DEFAULT_SELECT
  const values = votes.map((v) => ({
    channel: v.channel,
    raw: v.raw,
    normalized: v.normalized ?? '',
    text: rawOf(v),
  }))
  const byRaw = (index) => ({ value: values[index].raw, synthesized: false })

  if (isCommand(chosen)) {
    const out = runStrategy(chosen, 'select', { record: recordId, field: field.name, values }, root)
    if (Number.isInteger(out?.index)) {
      if (out.index < 0 || out.index >= votes.length) throw new AdjudicationError(`裁定命令返回的下标越界：${out.index}`)
      return byRaw(out.index)
    }
    if (out && Object.prototype.hasOwnProperty.call(out, 'value')) {
      const synthesized = values.some((v) => v.raw !== out.value && v.normalized === String(out.value ?? ''))
      return { value: out.value, synthesized: true, reason: out.reason }
    }
    throw new AdjudicationError('裁定命令输出既没有 index 也没有 value')
  }

  switch (chosen.builtin ?? 'first-valid') {
    case 'first-valid':
      return byRaw(0)
    case 'longest': {
      let best = 0
      for (let i = 1; i < votes.length; i += 1) {
        if (values[i].text.length > values[best].text.length) best = i
      }
      return byRaw(best)
    }
    case 'channel-order': {
      let best = 0
      for (let i = 1; i < votes.length; i += 1) {
        if (orderOf(chosen, contract, votes[i].channel) < orderOf(chosen, contract, votes[best].channel)) best = i
      }
      return byRaw(best)
    }
    case 'lowest':
    case 'highest': {
      let best = 0
      let bestValue = numericOf(votes[0])
      for (let i = 1; i < votes.length; i += 1) {
        const n = numericOf(votes[i])
        if ((chosen.builtin === 'lowest' && n < bestValue) || (chosen.builtin === 'highest' && n > bestValue)) {
          best = i
          bestValue = n
        }
      }
      return byRaw(best)
    }
    default:
      throw new AdjudicationError(`未知的 select 策略：${chosen.builtin}`)
  }
}

/**
 * Whether a member set describes the same items in a different order, which is
 * what `ordered-groups` accepts. Kept here so adjudicate can mark the decision
 * as synthesized without knowing which built-in ran.
 */
export function isReorderedAgreement(spec, votes) {
  if (isCommand(spec) || (spec?.builtin ?? '') !== 'ordered-groups') return false
  const texts = votes.map((v) => rawOf(v))
  return texts.some((t) => t !== texts[0])
}
