// lib/progress.js — progress-bar data abstraction for the composer dock.
//
// A progress bar is *data*, not a workflow: this module owns the document
// shape (`{ bars: Bar[] }`), the patch algebra that folds it, and the session
// projection that carries it to the client. It never decides when a bar is
// created, updated or destroyed — callers append whatever patches they want,
// and the document remembers nothing beyond what was folded.
//
// Two facts keep the fold replayable: patches carry their own timestamp (the
// reducer never reads the clock), and the fold is pure, so a restored session
// re-derives exactly the same bars.
import { nowIso } from './util.js'

/** Projection key the client dock reads. */
export const PROGRESS_KEY = 'curation-progress'

/** Session event type carrying one patch. Grammar: `plugin:<segments>`. */
export const PROGRESS_EVENT = 'plugin:data-curation/progress'

/** Bars kept visible at once; the client collapses the overflow into one line. */
export const BAR_LIMIT = 8

/** Status values a bar may carry. `running` is the default. */
export const BAR_STATUSES = ['idle', 'running', 'paused', 'done', 'error']

const ID_MAX = 64
const LABEL_MAX = 200
const DETAIL_MAX = 300
const UNIT_MAX = 16
const NUMBER_MAX = 1e12
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/** An empty progress document. */
export function emptyProgress() {
  return { bars: [] }
}

function cleanText(value, field, max, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`进度条缺少 ${field}`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`进度条 ${field} 必须是字符串`)
  const text = value.trim()
  if (required && text.length === 0) throw new Error(`进度条 ${field} 不能为空`)
  if (CONTROL_CHARS.test(text)) throw new Error(`进度条 ${field} 不能包含控制字符`)
  if (text.length > max) throw new Error(`进度条 ${field} 太长（上限 ${max} 字符）`)
  return text
}

function cleanNumber(value, field, min, max) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`进度条 ${field} 必须是有限数字`)
  if (value < min || value > max) throw new Error(`进度条 ${field} 必须在 ${min}..${max} 之间`)
  return value
}

/**
 * Validate one caller-supplied bar and return its canonical form. Throws a
 * Chinese error explaining the first offending field: the tool turns it into a
 * `{ ok: false }` result, so a bad patch never reaches the session log.
 * @param {unknown} raw - caller-supplied bar.
 * @param {number} index - position in the upsert array, for the message.
 * @returns {object} the canonical bar.
 */
export function normalizeBar(raw, index = 0) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`进度条 #${index + 1} 必须是对象`)
  }
  const id = cleanText(raw.id, 'id', ID_MAX, true)
  const label = cleanText(raw.label, 'label', LABEL_MAX)
  const detail = cleanText(raw.detail, 'detail', DETAIL_MAX)
  const unit = cleanText(raw.unit, 'unit', UNIT_MAX)
  const value = cleanNumber(raw.value, 'value', 0, NUMBER_MAX)
  const total = cleanNumber(raw.total, 'total', 0, NUMBER_MAX)
  const percent = cleanNumber(raw.percent, 'percent', 0, 100)
  if (total === 0) throw new Error('进度条 total 必须大于 0')
  const status = raw.status === undefined || raw.status === null ? 'running' : raw.status
  if (!BAR_STATUSES.includes(status)) throw new Error(`进度条 status 必须是 ${BAR_STATUSES.join('/')} 之一`)

  const bar = { id, status }
  if (label !== undefined) bar.label = label
  if (detail !== undefined) bar.detail = detail
  if (unit !== undefined) bar.unit = unit
  if (value !== undefined) bar.value = value
  if (total !== undefined) bar.total = total
  if (percent !== undefined) bar.percent = percent
  return bar
}

/**
 * Validate one patch: `{ upsert?, remove?, clear? }`. The patch is the only
 * write primitive; there is no create/update/destroy verb and no ordering
 * assumption, so callers may send one bar or ten in any order.
 * @param {unknown} raw - caller-supplied patch.
 * @returns {{upsert: object[], remove: string[], clear: boolean}} canonical patch.
 */
export function normalizePatch(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('进度补丁必须是对象：{upsert?, remove?, clear?}')
  }
  const rawUpsert = raw.upsert === undefined || raw.upsert === null ? [] : raw.upsert
  if (!Array.isArray(rawUpsert)) throw new Error('进度补丁 upsert 必须是数组')
  if (rawUpsert.length > BAR_LIMIT) throw new Error(`一次最多更新 ${BAR_LIMIT} 条进度`)
  const upsert = rawUpsert.map((bar, index) => normalizeBar(bar, index))
  const seen = new Set()
  for (const bar of upsert) {
    if (seen.has(bar.id)) throw new Error(`进度补丁里 id 重复：${bar.id}`)
    seen.add(bar.id)
  }

  const rawRemove = raw.remove === undefined || raw.remove === null ? [] : raw.remove
  if (!Array.isArray(rawRemove)) throw new Error('进度补丁 remove 必须是字符串数组')
  const remove = rawRemove.map((id) => cleanText(id, 'remove', ID_MAX, true))

  const clear = raw.clear === undefined ? false : Boolean(raw.clear)
  if (clear && (upsert.length > 0 || remove.length > 0)) {
    throw new Error('clear 不能与 upsert/remove 同时使用')
  }
  if (!clear && upsert.length === 0 && remove.length === 0) {
    throw new Error('进度补丁是空的：至少给出 upsert / remove / clear 之一')
  }
  return { upsert, remove, clear }
}

function isCanonicalBar(bar) {
  if (bar === null || typeof bar !== 'object' || Array.isArray(bar)) return false
  const { id, label, detail, unit, value, total, percent, status } = bar
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX || CONTROL_CHARS.test(id)) return false
  if (!BAR_STATUSES.includes(status)) return false
  if (label !== undefined && (typeof label !== 'string' || label.length > LABEL_MAX)) return false
  if (detail !== undefined && (typeof detail !== 'string' || detail.length > DETAIL_MAX)) return false
  if (unit !== undefined && (typeof unit !== 'string' || unit.length > UNIT_MAX)) return false
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return false
  if (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total) || total <= 0)) return false
  if (percent !== undefined && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)) return false
  return true
}

/**
 * Canonicalize any value into `{ bars }`. Used by both wire schemas: persisted
 * state and published views must never crash a session, so unknown shapes are
 * dropped rather than rejected. A canonical document is returned by reference,
 * which keeps projection change detection (`Object.is`) quiet.
 * @param {unknown} value - candidate document.
 * @returns {{bars: object[]}} canonical document.
 */
export function canonicalProgress(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyProgress()
  const source = Array.isArray(value.bars) ? value.bars : []
  const seen = new Set()
  // A missing/non-array `bars` is not a canonical document even when it yields
  // zero bars; only documents that already hold exactly the valid list pass
  // through by reference.
  let clean = Array.isArray(value.bars)
  const bars = []
  for (const bar of source) {
    if (!isCanonicalBar(bar) || seen.has(bar.id)) {
      clean = false
      continue
    }
    seen.add(bar.id)
    bars.push(bar)
  }
  if (clean) return value
  return { bars }
}

/**
 * Fold one patch into the document. Order is preserved: a touched bar keeps
 * its position, a new bar is appended, `remove` and `clear` drop entries. The
 * patch timestamp (recorded in the event) stamps every touched bar, so replay
 * is deterministic.
 * @param {{bars: object[]}} state - current document.
 * @param {{upsert?: object[], remove?: string[], clear?: boolean, at?: string}} patch - canonical patch plus its event timestamp.
 * @returns {{bars: object[]}} next document; the same reference when nothing changes.
 */
export function reduceProgress(state, patch) {
  const current = canonicalProgress(state)
  if (patch === null || typeof patch !== 'object') return current
  const upsert = Array.isArray(patch.upsert) ? patch.upsert : []
  const remove = Array.isArray(patch.remove) ? patch.remove : []
  const clear = patch.clear === true
  if (!clear && upsert.length === 0 && remove.length === 0) return current

  let bars = clear ? [] : current.bars.slice()
  if (remove.length > 0) {
    const drop = new Set(remove)
    bars = bars.filter((bar) => !drop.has(bar.id))
  }
  for (const raw of upsert) {
    // Patches are validated by the tool before they reach the log, but a fold
    // also replays data written by older versions, so a bad entry is skipped
    // rather than thrown: replay must never fail a session.
    let next
    try {
      next = normalizeBar(raw)
    } catch {
      continue
    }
    const at = bars.findIndex((bar) => bar.id === next.id)
    const merged = { ...(at >= 0 ? bars[at] : {}), ...next }
    if (typeof patch.at === 'string') merged.updatedAt = patch.at
    if (at >= 0) bars[at] = merged
    else bars.push(merged)
  }
  return { bars }
}

/**
 * The state/wire schema pair the projection registry expects. The registry
 * only ever calls `.parse` (see @deepseek-ai/dsh-session-projection), and this
 * package stays dependency-free, so the validator is the canonicalizing fold
 * above rather than a zod object.
 * @returns {{parse: (value: unknown) => {bars: object[]}}} a zod-shaped validator.
 */
export function progressSchema() {
  return { parse: (value) => canonicalProgress(value) }
}

/**
 * Register the `curation-progress` projection. Host-only plugins fold state
 * silently; the `wire` half is what the client dock reads through
 * `useProjection('curation-progress')`.
 * @param {object} ctx - host context carrying `sessionProjections`.
 */
export function registerProgressProjection(ctx) {
  if (!ctx.sessionProjections || typeof ctx.sessionProjections.register !== 'function') {
    // Hosts without the projection service still get the curation tools; only
    // the dock goes dark.
    if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-data-curation] sessionProjections 服务缺失，进度条投影未注册')
    return false
  }
  ctx.sessionProjections.register({
    key: PROGRESS_KEY,
    stateSchema: progressSchema(),
    init: () => emptyProgress(),
    apply: (state, event) => {
      if (event.type !== PROGRESS_EVENT) return state
      return reduceProgress(state, event.data ?? {})
    },
    wire: { viewSchema: progressSchema(), view: (state) => state },
    stateVersion: 1,
  })
  return true
}

/**
 * Append one patch as a plugin record: `ignorable`, outside the released event
 * map, so a reader that does not know this plugin skips it instead of refusing
 * the session.
 * @param {object} session - the calling agent's session.
 * @param {object} patch - canonical patch from {@link normalizePatch}.
 * @param {(session: object, type: string, data: object) => number} appendPluginRecord - host helper.
 * @returns {{at: string}} the stamped patch.
 */
export function appendProgressPatch(session, patch, appendPluginRecord) {
  const at = nowIso()
  const data = { ...patch, at }
  appendPluginRecord(session, PROGRESS_EVENT, data)
  return { at }
}
