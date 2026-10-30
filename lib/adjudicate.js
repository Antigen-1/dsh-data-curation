// lib/adjudicate.js — per-cell adjudication across independent channels.
//
// Rule: a value is accepted only when at least two *valid* channels agree on the
// same record and the same field. One valid channel is never enough, votes are
// never pooled across records, and a single channel that returns "not reported"
// for everything cannot manufacture a pass.
//
// What "agree" means, and which raw spelling is written, come from the
// contract's adjudication strategies (see lib/strategies.js): built-ins cover
// the common cases, and a project can replace either one per field with its own
// command. A strategy that errors does not fall back to a guess — the cell
// stays pending, because an unprovable cell must never enter the table.
import { normalizeValue, specFor } from './normalize.js'
import {
  AdjudicationError, groupVotes, isBatchSpec, isReorderedAgreement, resolveAdjudication,
  runBatchCompare, selectValue, strategyName, validateGroups,
} from './strategies.js'

const orderOf = (order, channel) => order.get(channel) ?? 99

/**
 * Decide one cell.
 * @param {object} args
 * @param {object} args.contract
 * @param {object} args.field        field definition from the contract
 * @param {string} args.recordId
 * @param {Array<{channel:string,status:string,values:object,evidence?:object}>} args.submissions
 * @param {string} [args.root]       project root, used as cwd for strategy commands
 */
/** Build the vote list for one cell (no grouping, no decisions). */
export function buildVotes({ contract, field, recordId, submissions }) {
  const spec = specFor(contract, field)
  const votes = []
  const seen = new Set()
  const notes = []
  for (const sub of submissions) {
    if (seen.has(sub.channel)) {
      notes.push(`通道 ${sub.channel} 对 ${recordId} 重复提交，仅采用第一份`)
      continue
    }
    seen.add(sub.channel)
    const valid = sub.status === 'valid'
    const present = Boolean(sub.values) && Object.prototype.hasOwnProperty.call(sub.values, field.name)
    const raw = present ? sub.values[field.name] : null
    votes.push({
      channel: sub.channel,
      valid,
      present,
      raw,
      normalized: valid && present ? normalizeValue(raw, spec) : null,
      evidence: (sub.evidence && sub.evidence[field.name]) || null,
    })
  }
  return { votes, notes }
}

export function decideCell({ contract, field, recordId, submissions, root, groups, groupError }) {
  const spec = specFor(contract, field)
  const strategies = resolveAdjudication(contract, field)
  const { votes, notes } = buildVotes({ contract, field, recordId, submissions })

  const base = {
    record: recordId,
    field: field.name,
    votes,
    notes,
    strategy: { compare: strategyName(strategies.compare), select: strategyName(strategies.select) },
  }
  const pendingOf = (reason, extra = {}) => ({
    ...base,
    status: 'pending',
    reason,
    value: null,
    normalized: null,
    adopted: [],
    ...extra,
  })

  const usable = votes.filter((v) => v.valid && v.present)
  if (usable.length === 0) return pendingOf('no_valid_channel')
  if (usable.length < 2) return pendingOf('no_two_channel_agreement')

  if (groupError) {
    notes.push(groupError)
    return pendingOf('adjudicator_error', { detail: groupError })
  }
  let groupList
  if (Array.isArray(groups)) {
    groupList = groups
  } else {
    try {
      groupList = groupVotes({ votes: usable, spec: strategies.compare, contract, field, recordId, root })
    } catch (e) {
      if (e instanceof AdjudicationError) {
        notes.push(e.message)
        return pendingOf(e.code, { detail: e.message })
      }
      throw e
    }
  }

  const candidates = groupList.filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)
  if (candidates.length === 0) return pendingOf('no_two_channel_agreement')
  if (candidates.length > 1) return pendingOf('competing_majorities')

  const order = new Map((contract.channels ?? []).map((c, i) => [c.name, i]))
  const members = candidates[0]
    .map((i) => usable[i])
    .sort((a, b) => orderOf(order, a.channel) - orderOf(order, b.channel))

  let picked
  try {
    picked = selectValue({ votes: members, spec: strategies.select, contract, field, recordId, root })
  } catch (e) {
    if (e instanceof AdjudicationError) {
      notes.push(e.message)
      return pendingOf(e.code, { detail: e.message })
    }
    throw e
  }

  const normalized = normalizeValue(picked.value, spec)
  if (normalized === '' && field.allowEmpty === false) return pendingOf('empty_not_allowed')

  const adopted = members.map((v) => v.channel)
  const evidence = members.map((v) => ({
    channel: v.channel,
    page: v.evidence?.page ?? null,
    quote: v.evidence?.quote ?? null,
  }))
  const evidenceRequired = field.requireEvidence ?? contract.evidence?.required ?? true
  if (evidenceRequired && normalized !== '' && !evidence.some((e) => e.page !== null || e.quote)) {
    return pendingOf('missing_evidence', { adopted })
  }

  const dissent = usable
    .filter((v) => !members.includes(v))
    .map((v) => ({ channel: v.channel, raw: v.raw, normalized: v.normalized }))
    .sort((a, b) => orderOf(order, a.channel) - orderOf(order, b.channel))

  return {
    ...base,
    status: 'accepted',
    reason: 'two_channel_agreement',
    value: picked.value,
    normalized,
    adopted,
    evidence,
    dissent,
    synthesized: Boolean(picked.synthesized) || isReorderedAgreement(strategies.compare, members),
    ...(picked.reason ? { selectionReason: picked.reason } : {}),
  }
}

/**
 * Adjudicate every requested cell.
 * @param {object} args
 * @param {object} args.contract
 * @param {string[]} args.recordIds
 * @param {string[]} [args.fields]      default: all contract fields
 * @param {Map<string, Array<object>>} args.submissionsByRecord
 * @param {string} [args.root]          project root for strategy commands
 * @returns {Array<object>} decisions
 */
export function adjudicate({ contract, recordIds, fields, submissionsByRecord, root, cells }) {
  const byName = new Map(contract.fields.map((f) => [f.name, f]))
  const targets = []
  if (Array.isArray(cells)) {
    for (const cell of cells) {
      const field = byName.get(cell.field)
      if (field) targets.push({ recordId: String(cell.record), field })
    }
  } else {
    const chosen = fields?.length ? contract.fields.filter((f) => fields.includes(f.name)) : contract.fields
    for (const recordId of recordIds) for (const field of chosen) targets.push({ recordId, field })
  }

  const cellKey = (record, field) => `${record}\u0000${field}`

  // 1) Cells whose compare strategy asked for batch mode: one command call per
  //    distinct strategy spec, no matter how many cells it covers.
  const precomputed = new Map()
  const batches = new Map()
  for (const target of targets) {
    const strategies = resolveAdjudication(contract, target.field)
    if (!isBatchSpec(strategies.compare)) continue
    const subs = submissionsByRecord.get(target.recordId) ?? []
    const { votes } = buildVotes({ contract, field: target.field, recordId: target.recordId, submissions: subs })
    const usable = votes.filter((v) => v.valid && v.present)
    if (usable.length < 2) continue
    const key = JSON.stringify(strategies.compare)
    if (!batches.has(key)) batches.set(key, { spec: strategies.compare, items: [] })
    batches.get(key).items.push({ target, usable })
  }
  for (const { spec, items } of batches.values()) {
    let results
    try {
      results = runBatchCompare({
        spec,
        cells: items.map((i) => ({
          record: i.target.recordId,
          field: i.target.field.name,
          values: i.usable.map((v) => ({ channel: v.channel, raw: v.raw, normalized: v.normalized ?? '' })),
        })),
        root,
      })
    } catch (e) {
      if (!(e instanceof AdjudicationError)) throw e
      for (const i of items) precomputed.set(cellKey(i.target.recordId, i.target.field.name), { groupError: e.message })
      continue
    }
    const seen = new Set()
    for (const res of results) {
      const k = cellKey(res?.record, res?.field)
      if (seen.has(k)) throw new AdjudicationError(`批量裁定命令返回了重复的格：${res?.record}.${res?.field}`)
      seen.add(k)
    }
    for (const i of items) {
      const k = cellKey(i.target.recordId, i.target.field.name)
      const found = results.find((r) => cellKey(r?.record, r?.field) === k)
      if (!found) {
        precomputed.set(k, { groupError: `批量策略缺少结果：${i.target.recordId}.${i.target.field.name}` })
        continue
      }
      try {
        precomputed.set(k, { groups: validateGroups(found.groups, i.usable) })
      } catch (e) {
        if (!(e instanceof AdjudicationError)) throw e
        precomputed.set(k, { groupError: e.message })
      }
    }
  }

  // 2) Decide every cell; batch results are injected where they exist.
  const out = []
  for (const target of targets) {
    const subs = submissionsByRecord.get(target.recordId) ?? []
    const pre = precomputed.get(cellKey(target.recordId, target.field.name))
    out.push(decideCell({
      contract, field: target.field, recordId: target.recordId, submissions: subs, root, ...(pre ?? {}),
    }))
  }
  return out
}

/** Compact counts for summaries and HUD-style rendering. */
export function summarize(decisions) {
  const accepted = decisions.filter((d) => d.status === 'accepted')
  const pending = decisions.filter((d) => d.status !== 'accepted')
  const reasons = {}
  for (const d of pending) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
  return {
    total: decisions.length,
    accepted: accepted.length,
    pending: pending.length,
    byReason: reasons,
    synthesized: accepted.filter((d) => d.synthesized).length,
    pendingCells: pending.map((d) => ({ record: d.record, field: d.field, reason: d.reason })),
  }
}
