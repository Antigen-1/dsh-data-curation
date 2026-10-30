// lib/pin.js — v5 project pins: the project's meta information frozen as one
// immutable aggregate snapshot.
//
// A pin has two layers:
//   global  project / table registry / defaults / aggregate snapshot
//   table   one effective config per table (materialized from defaults+overrides)
//
// Validation never writes: it produces the canonical aggregate snapshot and the
// per-table effective configs that the writer stores.
import { RESERVED_TABLES } from './db.js'
import { CONTRACT_VERSION, contractHash, validateContract } from './contract.js'
import { sha256 } from './util.js'

export const PIN_VERSION = 5
export const PIN_ALGORITHM = 'sha256/canonical-json'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const TABLE_KEYS = new Set([
  'table', 'key', 'purpose', 'status', 'records', 'fields',
  'channels', 'normalization', 'evidence', 'gates', 'adjudication',
])
const DEFAULT_KEYS = new Set(['channels', 'normalization', 'evidence', 'gates', 'adjudication'])

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)))

/** Deterministic JSON for hashing (sorted keys; array order preserved). */
export function stableJson(value) {
  if (value === null || value === undefined) return JSON.stringify(null)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

/**
 * Canonical aggregate snapshot: undefined removed, tables sorted by table id,
 * fields/channels keep declaration order (they decide column layout and channel
 * precedence, so order is meaningful).
 */
export function canonicalPin(pin) {
  const copy = clone(pin)
  if (Array.isArray(copy?.tables)) {
    copy.tables = [...copy.tables]
      .map((t) => clone(t))
      .sort((a, b) => String(a.table).localeCompare(String(b.table)))
  }
  return copy
}

export const pinHash = (pin) => sha256(stableJson(canonicalPin(pin)))
export const tableHash = (effective) => sha256(stableJson(clone(effective)))

function mergeNormalization(base = {}, override = {}) {
  const merged = { ...base, ...override }
  if (base.synonyms || override.synonyms) {
    merged.synonyms = { ...(base.synonyms ?? {}), ...(override.synonyms ?? {}) }
  }
  return merged
}

function mergeAdjudication(base, override) {
  if (!base) return override ? clone(override) : undefined
  if (!override) return clone(base)
  const merged = { ...clone(base), ...clone(override) }
  merged.fields = { ...(base.fields ?? {}) }
  for (const [name, entry] of Object.entries(override.fields ?? {})) {
    merged.fields[name] = { ...(base.fields?.[name] ?? {}), ...clone(entry) }
  }
  return merged
}

/**
 * Merge project defaults into one table's declared config.
 * Fixed order: raw layers → project → table → field (adjudication only) →
 * defaults materialized once → cross-reference validation.
 */
export function mergeTable(defaults = {}, table = {}) {
  const effective = {
    version: CONTRACT_VERSION,
    fields: clone(table.fields),
    records: clone(table.records),
    delivery: { table: table.table, key: table.key },
  }
  const channels = table.channels ?? defaults.channels
  if (channels !== undefined) effective.channels = clone(channels)
  effective.normalization = mergeNormalization(defaults.normalization, table.normalization)
  effective.evidence = { ...(defaults.evidence ?? {}), ...(table.evidence ?? {}) }
  effective.gates = { ...(defaults.gates ?? {}), ...(table.gates ?? {}) }
  const adjudication = mergeAdjudication(defaults.adjudication, table.adjudication)
  if (adjudication) effective.adjudication = adjudication
  return effective
}

/** Which layer supplied each user-visible leaf (for A8's provenance query). */
export function configSources(defaults = {}, table = {}) {
  const pick = (key) => (table[key] !== undefined ? 'table' : defaults[key] !== undefined ? 'project' : 'default')
  const sources = {
    channels: pick('channels'),
    normalization: pick('normalization'),
    evidence: pick('evidence'),
    gates: pick('gates'),
    adjudication: pick('adjudication'),
  }
  for (const [name, entry] of Object.entries({ ...(defaults.adjudication?.fields ?? {}), ...(table.adjudication?.fields ?? {}) })) {
    sources[`adjudication.fields.${name}`] = table.adjudication?.fields?.[name] !== undefined ? 'table' : 'project'
  }
  return sources
}

function validateDefaults(defaults, errors) {
  if (!isPlainObject(defaults)) {
    errors.push('project.defaults 必须是对象')
    return
  }
  for (const key of Object.keys(defaults)) if (!DEFAULT_KEYS.has(key)) errors.push(`project.defaults 有未知键：${key}`)
  if (defaults.channels !== undefined) {
    if (!Array.isArray(defaults.channels) || defaults.channels.length < 2) {
      errors.push('defaults.channels 必须是至少两个通道的数组')
    } else {
      const names = new Set()
      for (const [i, ch] of defaults.channels.entries()) {
        if (!ch || typeof ch.name !== 'string' || !ch.name.trim()) errors.push(`defaults.channels[${i}].name 缺失`)
        else if (names.has(ch.name.trim())) errors.push(`defaults.channels 通道名重复：${ch.name}`)
        else names.add(ch.name.trim())
      }
    }
  }
  if (defaults.normalization !== undefined && !isPlainObject(defaults.normalization)) errors.push('defaults.normalization 必须是对象')
  if (defaults.evidence !== undefined && !isPlainObject(defaults.evidence)) errors.push('defaults.evidence 必须是对象')
  if (defaults.gates !== undefined && !isPlainObject(defaults.gates)) errors.push('defaults.gates 必须是对象')
  if (defaults.adjudication !== undefined && !isPlainObject(defaults.adjudication)) errors.push('defaults.adjudication 必须是对象')
}

/**
 * Validate a v5 pin.
 * @returns {{ok:boolean,errors:string[],pin?:object,tables?:Array,defaults?:object}}
 */
export function validatePin(input) {
  const errors = []
  const c = input && typeof input === 'object' ? clone(input) : null
  if (!c) return { ok: false, errors: ['pin 必须是对象'] }

  if (c.version !== undefined && c.version !== PIN_VERSION) {
    if (c.version === 4 || c.version === CONTRACT_VERSION) {
      return {
        ok: false,
        errors: [`v4 契约格式已停用：0.6.0 起只接受 v5 pin（{version:5, project, tables:[…]}），请按 docs/MIGRATION.md 迁移（旧的单表契约可用 curation_init + curation_pin 重建）`],
      }
    }
    errors.push(`pin 版本不支持：v${c.version}（当前 v${PIN_VERSION}）`)
  }
  c.version = PIN_VERSION

  if (!isPlainObject(c.project)) errors.push('project 必须是对象')
  else {
    for (const key of Object.keys(c.project)) {
      if (!['name', 'description'].includes(key)) errors.push(`project 有未知键：${key}`)
    }
    if (c.project.name !== undefined && c.project.name !== null && typeof c.project.name !== 'string') errors.push('project.name 必须是字符串')
    if (c.project.description !== undefined && c.project.description !== null && typeof c.project.description !== 'string') errors.push('project.description 必须是字符串')
  }
  c.project = { name: c.project?.name ?? null, description: c.project?.description ?? null }

  if (c.defaults === undefined) c.defaults = {}
  validateDefaults(c.defaults, errors)

  if (!Array.isArray(c.tables) || c.tables.length === 0) {
    errors.push('tables 必须是非空数组（每项至少含 table、key、records、fields）')
    return { ok: false, errors }
  }

  const seen = new Set()
  const tables = []
  for (const [i, t] of c.tables.entries()) {
    const at = `tables[${i}]`
    if (!isPlainObject(t)) { errors.push(`${at} 必须是对象`); continue }
    for (const key of Object.keys(t)) if (!TABLE_KEYS.has(key)) errors.push(`${at} 有未知键：${key}`)
    if (typeof t.table !== 'string' || !IDENT.test(t.table) || RESERVED_TABLES.has(t.table.toLowerCase())) {
      errors.push(`${at}.table 必须是合法表名且不能占用状态表：${t.table}`)
      continue
    }
    if (seen.has(t.table)) { errors.push(`表名重复：${t.table}`); continue }
    seen.add(t.table)
    if (typeof t.key !== 'string' || !IDENT.test(t.key)) errors.push(`${at}.key 必须是合法列名`)
    if (t.purpose !== undefined && t.purpose !== null && typeof t.purpose !== 'string') errors.push(`${at}.purpose 必须是字符串`)
    if (t.status !== undefined && !['active', 'retired'].includes(t.status)) errors.push(`${at}.status 只能是 active 或 retired`)

    const effective = mergeTable(c.defaults, t)
    const check = validateContract(effective)
    if (!check.ok) {
      for (const e of check.errors) errors.push(`${at}（表 ${t.table}）：${e}`)
      continue
    }
    tables.push({
      tableId: t.table,
      declared: clone(t),
      status: t.status ?? 'active',
      effective: check.contract,
      effectiveHash: tableHash(check.contract),
      sources: configSources(c.defaults, t),
    })
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, errors: [], pin: canonicalPin(c), defaults: c.defaults, tables }
}

/** Build the aggregate snapshot the writer stores (raw declarations + registry). */
export function buildAggregate({ project, defaults, tables, registry }) {
  const snap = {
    version: PIN_VERSION,
    project: { name: project?.name ?? null, description: project?.description ?? null },
    defaults: clone(defaults ?? {}),
    tables: tables.map((t) => clone(t)),
  }
  if (registry) snap.registry = registry.map((r) => clone(r))
  return canonicalPin(snap)
}

export function activeTables(pin) {
  return (pin?.tables ?? []).filter((t) => (t.status ?? 'active') === 'active')
}

export function tableById(pin, tableId) {
  const t = (pin?.tables ?? []).find((row) => row.table === tableId)
  if (!t) return null
  return t
}

/** Table name for a single-table operation; multiple tables need an explicit id. */
export function pickTable(pin, requested) {
  const active = activeTables(pin)
  if (requested) {
    const found = tableById(pin, requested)
    if (!found) return { error: `pin 中没有这张表：${requested}（可用：${(pin?.tables ?? []).map((t) => t.table).join(', ')}）` }
    if ((found.status ?? 'active') === 'retired') return { error: `表 ${requested} 已退役：只读，不能提交/比对/落表` }
    return { table: found }
  }
  if (active.length === 1) return { table: active[0] }
  if (active.length === 0) return { error: 'pin 中没有 active 表' }
  return { error: `pin 中有 ${active.length} 张 active 表（${active.map((t) => t.table).join(', ')}）：多表操作需要显式 table 参数` }
}

export { RESERVED_TABLES }
