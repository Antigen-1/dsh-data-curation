// test/_pin.js — test-only adapter: the suite was written against the v4
// single-table contract, so build a v5 pin from one and call doPin().
import { doPin } from '../lib/core.js'

export function toPin(contract, { table = contract?.delivery?.table ?? 'summary', name = 'test' } = {}) {
  const defaults = {}
  for (const key of ['channels', 'normalization', 'evidence', 'gates', 'adjudication']) {
    if (contract?.[key] !== undefined) defaults[key] = contract[key]
  }
  const entry = {
    table,
    key: contract?.delivery?.key ?? 'record_id',
    records: contract?.records,
    fields: contract?.fields,
  }
  if (contract?.purpose) entry.purpose = contract.purpose
  return { version: 5, project: { name }, defaults, tables: [entry] }
}

/** Same call shape as the old doContract({cwd, contract, force, dryRun}). */
export const doPinCompat = (args = {}) => doPin({
  cwd: args.cwd,
  stateDir: args.stateDir,
  pin: args.pin ?? toPin(args.contract),
  force: args.force,
  dryRun: args.dryRun,
  reason: args.reason,
})
