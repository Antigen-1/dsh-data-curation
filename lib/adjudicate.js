// lib/adjudicate.js — per-cell adjudication across independent channels.
//
// Rule: a value is accepted only when at least two *valid* channels agree on the
// same normalized value for the same record and the same field. One valid
// channel is never enough, votes are never pooled across records, and a single
// channel that returns "not reported" for everything cannot manufacture a pass.
import { normalizeValue, specFor } from './normalize.js'

/**
 * Decide one cell.
 * @param {object} args
 * @param {object} args.contract
 * @param {object} args.field    field definition from the contract
 * @param {string} args.recordId
 * @param {Array<{channel:string,status:string,values:object,evidence?:object}>} args.submissions
 */
export function decideCell({ contract, field, recordId, submissions }) {
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

  const usable = votes.filter((v) => v.valid && v.present)
  const groups = new Map()
  for (const v of usable) {
    if (!groups.has(v.normalized)) groups.set(v.normalized, [])
    groups.get(v.normalized).push(v)
  }
  const candidates = [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)

  const base = { record: recordId, field: field.name, votes, notes }

  if (candidates.length === 0) {
    return {
      ...base,
      status: 'pending',
      reason: usable.length === 0 ? 'no_valid_channel' : 'no_two_channel_agreement',
      value: null,
      normalized: null,
      adopted: [],
    }
  }
  if (candidates.length > 1) {
    return {
      ...base,
      status: 'pending',
      reason: 'competing_majorities',
      value: null,
      normalized: null,
      adopted: [],
    }
  }

  const [normalized, membersUnordered] = candidates[0]
  // Contract channel order = preference order for the stored raw spelling.
  const order = new Map((contract.channels ?? []).map((c, i) => [c.name, i]))
  const members = [...membersUnordered].sort(
    (a, b) => (order.get(a.channel) ?? 99) - (order.get(b.channel) ?? 99),
  )
  if (normalized === '' && field.allowEmpty === false) {
    return { ...base, status: 'pending', reason: 'empty_not_allowed', value: null, normalized: null, adopted: [] }
  }

  const adopted = members.map((v) => v.channel)
  const evidence = members.map((v) => ({
    channel: v.channel,
    page: v.evidence?.page ?? null,
    quote: v.evidence?.quote ?? null,
  }))
  const evidenceRequired = field.requireEvidence ?? contract.evidence?.required ?? true
  if (evidenceRequired && normalized !== '' && !evidence.some((e) => e.page !== null || e.quote)) {
    return { ...base, status: 'pending', reason: 'missing_evidence', value: null, normalized: null, adopted }
  }

  const dissent = votes
    .filter((v) => v.valid && v.present && v.normalized !== normalized)
    .map((v) => ({ channel: v.channel, raw: v.raw, normalized: v.normalized }))
    .sort((a, b) => (order.get(a.channel) ?? 99) - (order.get(b.channel) ?? 99))

  return {
    ...base,
    status: 'accepted',
    reason: 'two_channel_agreement',
    value: members[0].raw,
    normalized,
    adopted,
    evidence,
    dissent,
  }
}

/**
 * Adjudicate every requested cell.
 * @param {object} args
 * @param {object} args.contract
 * @param {string[]} args.recordIds
 * @param {string[]} [args.fields]      default: all contract fields
 * @param {Map<string, Array<object>>} args.submissionsByRecord
 * @returns {Array<object>} decisions
 */
export function adjudicate({ contract, recordIds, fields, submissionsByRecord }) {
  const chosen = fields?.length ? contract.fields.filter((f) => fields.includes(f.name)) : contract.fields
  const out = []
  for (const recordId of recordIds) {
    const subs = submissionsByRecord.get(recordId) ?? []
    for (const field of chosen) {
      out.push(decideCell({ contract, field, recordId, submissions: subs }))
    }
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
    pendingCells: pending.map((d) => ({ record: d.record, field: d.field, reason: d.reason })),
  }
}
