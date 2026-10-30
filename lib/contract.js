// lib/contract.js — the project's "口径契约": fields, channels, curated table, gates.
//
// The contract is the single source of truth for what "correct" means in a
// project. It carries no project-specific data of its own, so the plugin stays
// reusable across domains: swap the contract, keep the machinery.
//
// v3 models a project as (read-only sources) + (one workspace SQLite file):
// the contract names the curated table inside that workspace, never a database
// path — there is exactly one place writes can land.
//
// v4 adds the optional `adjudication` block: which values count as agreeing and
// which raw spelling is written are part of the contract, because both change
// what the table ends up saying. A contract signed under one policy must never
// be re-read under another, so the version travels with the hash.
import { RESERVED_TABLES } from './db.js'
import { COMPARE_BUILTINS, SELECT_BUILTINS } from './strategies.js'
import { sha256 } from './util.js'

export const CONTRACT_VERSION = 4

/** SQLite identifiers we are willing to interpolate into DDL. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Deterministic JSON (sorted object keys) for hashing. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/**
 * JSON-canonical form of a contract.
 *
 * `JSON.stringify` silently drops keys whose value is `undefined`, and that is
 * exactly how the contract is stored. Hashing the in-memory object would then
 * disagree with hashing the stored one ("契约被手工改动" on the very next read),
 * so both paths hash the canonical form.
 */
export function canonicalContract(contract) {
  return contract === null || contract === undefined ? contract : JSON.parse(JSON.stringify(contract))
}

export const contractHash = (contract) => sha256(stableStringify(canonicalContract(contract)))

const FIELD_TYPES = new Set(['text', 'enum', 'number', 'date'])

/** SQLite column type for a contract field type. */
export function sqlType(field) {
  return field?.type === 'number' ? 'REAL' : 'TEXT'
}

/** A table name that may live inside the workspace. */
export function isSafeTableName(name) {
  return typeof name === 'string' && IDENT.test(name) && !RESERVED_TABLES.has(name.toLowerCase())
}

/** Project-relative path: no absolute paths, no `..` segments. */
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p.trim()) return false
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return false
  return !p.split(/[\\/]/).includes('..')
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const ADJUDICATION_KEYS = new Set(['compare', 'select', 'fields'])
const STRATEGY_KEYS = {
  compare: new Set(['builtin', 'command', 'args', 'timeoutMs', 'tolerance', 'mode', 'separator', 'options', 'batch']),
  select: new Set(['builtin', 'command', 'args', 'timeoutMs', 'order', 'options']),
}

/**
 * One strategy spec: either a built-in name plus its options, or a command.
 * A command is not a "fallback": if it fails the cell stays pending.
 */
function validateStrategy(spec, kind, at, errors, channelNames) {
  if (!isPlainObject(spec)) {
    errors.push(`${at} 必须是对象`)
    return
  }
  const hasBuiltin = typeof spec.builtin === 'string'
  const hasCommand = typeof spec.command === 'string'
  if (hasBuiltin === hasCommand) errors.push(`${at} 需要且只能有 builtin 或 command 之一`)
  if (hasBuiltin) {
    const allowed = kind === 'compare' ? COMPARE_BUILTINS : SELECT_BUILTINS
    if (!allowed.includes(spec.builtin)) errors.push(`${at}.builtin 不支持：${spec.builtin}（可用：${allowed.join('、')}）`)
  }
  if (hasCommand) {
    if (!spec.command.trim()) errors.push(`${at}.command 不能为空`)
    if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string'))) {
      errors.push(`${at}.args 必须是字符串数组`)
    }
    if (spec.timeoutMs !== undefined
      && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1000 || spec.timeoutMs > 600000)) {
      errors.push(`${at}.timeoutMs 必须是 1000..600000 的整数`)
    }
  }
  if (spec.tolerance !== undefined) {
    if (typeof spec.tolerance !== 'number' || !Number.isFinite(spec.tolerance) || spec.tolerance < 0) {
      errors.push(`${at}.tolerance 必须是非负数字`)
    }
    if (kind !== 'compare') errors.push(`${at}.tolerance 只对 compare 有意义`)
  }
  if (spec.mode !== undefined && !['absolute', 'relative'].includes(spec.mode)) {
    errors.push(`${at}.mode 只支持 absolute、relative`)
  }
  if (spec.separator !== undefined && (typeof spec.separator !== 'string' || !spec.separator)) {
    errors.push(`${at}.separator 必须是非空字符串（分隔符集合，如 "、,;"）`)
  }
  if (spec.order !== undefined) {
    if (!Array.isArray(spec.order) || spec.order.some((s) => typeof s !== 'string')) {
      errors.push(`${at}.order 必须是通道名数组`)
    } else {
      for (const name of spec.order) {
        if (!channelNames.has(name)) errors.push(`${at}.order 引用了未声明的通道：${name}`)
      }
    }
  }
  if (spec.batch !== undefined) {
    if (typeof spec.batch !== 'boolean') errors.push(`${at}.batch 必须是布尔值`)
    if (kind !== 'compare') errors.push(`${at}.batch 只对 compare 有意义`)
    if (spec.batch === true && !hasCommand) errors.push(`${at}.batch 只能与 command 一起使用（内置策略已是批量）`)
  }
  if (spec.options !== undefined && !isPlainObject(spec.options)) errors.push(`${at}.options 必须是对象`)
  for (const key of Object.keys(spec)) {
    if (!STRATEGY_KEYS[kind].has(key)) errors.push(`${at} 有未知键：${key}`)
  }
}

function validateAdjudication(block, { fieldNames: knownFields, channelNames, errors }) {
  if (!isPlainObject(block)) {
    errors.push('adjudication 必须是对象')
    return
  }
  for (const key of Object.keys(block)) {
    if (!ADJUDICATION_KEYS.has(key)) errors.push(`adjudication 有未知键：${key}`)
  }
  if (block.compare !== undefined) validateStrategy(block.compare, 'compare', 'adjudication.compare', errors, channelNames)
  if (block.select !== undefined) validateStrategy(block.select, 'select', 'adjudication.select', errors, channelNames)
  if (block.fields === undefined) return
  if (!isPlainObject(block.fields)) {
    errors.push('adjudication.fields 必须是对象')
    return
  }
  for (const [name, entry] of Object.entries(block.fields)) {
    const at = `adjudication.fields.${name}`
    if (!knownFields.has(name)) errors.push(`${at} 不是契约里声明的字段`)
    if (!isPlainObject(entry)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'compare' && key !== 'select') errors.push(`${at} 有未知键：${key}`)
    }
    if (entry.compare !== undefined) validateStrategy(entry.compare, 'compare', `${at}.compare`, errors, channelNames)
    if (entry.select !== undefined) validateStrategy(entry.select, 'select', `${at}.select`, errors, channelNames)
  }
}

/**
 * Validate and canonicalize a contract.
 * @returns {{ok:boolean,errors:string[],contract?:object}}
 */
export function validateContract(input) {
  const errors = []
  const c = input && typeof input === 'object' ? structuredClone(input) : null
  if (!c) return { ok: false, errors: ['contract 必须是对象'] }

  if (c.version !== undefined) {
    if (!Number.isInteger(c.version)) errors.push('version 必须是整数')
    else if (c.version < CONTRACT_VERSION) errors.push(`契约版本过旧（v${c.version}，当前 v${CONTRACT_VERSION}）：请升级契约后重新签署 curation_contract`)
    else if (c.version > CONTRACT_VERSION) errors.push(`契约版本 v${c.version} 高于当前插件支持的 v${CONTRACT_VERSION}：请升级插件后再签署`)
  }
  c.version = CONTRACT_VERSION

  if (!Array.isArray(c.fields) || c.fields.length === 0) errors.push('fields 必须是非空数组')
  const names = new Set()
  for (const [i, f] of (c.fields ?? []).entries()) {
    if (!f || typeof f !== 'object') { errors.push(`fields[${i}] 必须是对象`); continue }
    if (typeof f.name !== 'string' || !f.name.trim()) errors.push(`fields[${i}].name 缺失`)
    else if (!IDENT.test(f.name.trim())) errors.push(`字段名只能用字母、数字、下划线且不能以数字开头：${f.name}`)
    else if (names.has(f.name.trim())) errors.push(`字段名重复：${f.name}`)
    else names.add(f.name.trim())
    if (f.type !== undefined && !FIELD_TYPES.has(f.type)) errors.push(`fields[${i}].type 不支持：${f.type}`)
    if (f.normalize !== undefined && !isPlainObject(f.normalize)) errors.push(`fields[${i}].normalize 必须是对象`)
    if (f.allowEmpty !== undefined && typeof f.allowEmpty !== 'boolean') errors.push(`fields[${i}].allowEmpty 必须是布尔值`)
  }

  if (!c.records || typeof c.records !== 'object') {
    errors.push('records 缺失（{kind:"list",values} / {kind:"file",path,key} / {kind:"db",db,table,key}）')
  } else if (c.records.kind === 'list') {
    if (!Array.isArray(c.records.values) || c.records.values.length === 0) errors.push('records.values 必须是非空数组')
    else if (c.records.values.some((v) => String(v).trim() === '')) errors.push('records.values 不能有空记录键')
  } else if (c.records.kind === 'file') {
    if (!isSafeRelPath(c.records.path)) errors.push('records.path 必须是项目内相对路径（不得绝对、不得含 ..）')
    if (typeof c.records.key !== 'string' || !c.records.key) errors.push('records.key 缺失')
  } else if (c.records.kind === 'db') {
    if (!isSafeRelPath(c.records.db)) errors.push('records.db 必须是项目内相对路径（不得绝对、不得含 ..）')
    if (!isSafeTableName(c.records.table)) errors.push('records.table 必须是合法表名（不能占用状态表名）')
    if (typeof c.records.key !== 'string' || !c.records.key) errors.push('records.key 缺失')
  } else {
    errors.push('records.kind 只支持 list、file 或 db')
  }

  if (!c.delivery || typeof c.delivery !== 'object') {
    errors.push('delivery 缺失（{table,key}：curated 表在项目工作区 SQLite 里，由本插件创建并写入）')
  } else {
    if (!isSafeTableName(c.delivery.table)) {
      errors.push(`delivery.table 必须是合法表名且不能占用状态表（${[...RESERVED_TABLES].join('/')}）：${c.delivery.table}`)
    }
    if (typeof c.delivery.key !== 'string' || !IDENT.test(c.delivery.key)) {
      errors.push('delivery.key 必须是合法列名（字母、数字、下划线）')
    } else if (names.has(c.delivery.key)) {
      errors.push(`delivery.key 不能与字段同名：${c.delivery.key}（键列由插件维护，字段列来自契约）`)
    }
    if (c.delivery.db !== undefined) {
      errors.push('delivery.db 已废弃：交付表固定写入项目工作区 SQLite，请从契约移除该键')
    }
  }

  const channelNames = new Set()
  if (c.channels === undefined) {
    c.channels = [{ name: 'text', method: 'text-extract' }, { name: 'vision', method: 'model-image' }]
  }
  if (!Array.isArray(c.channels) || c.channels.length < 1) {
    errors.push('channels 必须是非空数组')
  } else {
    for (const [i, ch] of c.channels.entries()) {
      if (!ch || typeof ch.name !== 'string' || !ch.name.trim()) errors.push(`channels[${i}].name 缺失`)
      else if (channelNames.has(ch.name.trim())) errors.push(`通道名重复：${ch.name}`)
      else channelNames.add(ch.name.trim())
    }
    if (c.channels.length < 2) errors.push('至少需要两个通道：单通道结果不允许自动采纳')
  }

  if (c.adjudication !== undefined) {
    validateAdjudication(c.adjudication, { fieldNames: names, channelNames, errors })
  }

  if (c.gates !== undefined && !isPlainObject(c.gates)) errors.push('gates 必须是对象')
  const ratio = c.gates?.minAcceptedRatio
  if (ratio !== undefined && (typeof ratio !== 'number' || ratio < 0 || ratio > 1)) {
    errors.push('gates.minAcceptedRatio 必须是 0..1 的数字')
  }
  if (c.gates?.verifyCmd !== undefined && c.gates.verifyCmd !== null && typeof c.gates.verifyCmd !== 'string') {
    errors.push('gates.verifyCmd 必须是字符串或 null')
  }

  if (c.exporters !== undefined) {
    errors.push('exporters 不再写在契约里：导出器是可修改的项目状态，请用 curation_exporter 注册（存于工作区数据库）')
  }

  if (c.identity !== undefined && !isPlainObject(c.identity)) errors.push('identity 必须是对象')

  if (errors.length) return { ok: false, errors }

  c.fields = c.fields.map((f) => ({ ...f, name: f.name.trim() }))
  c.channels = c.channels.map((ch) => ({ ...ch, name: ch.name.trim() }))
  c.delivery = { table: c.delivery.table, key: c.delivery.key }
  c.normalization = { mode: 'safe', ...(c.normalization ?? {}) }
  c.evidence = { required: true, ...(c.evidence ?? {}) }
  c.gates = { minAcceptedRatio: 0, ...(c.gates ?? {}) }
  return { ok: true, errors: [], contract: canonicalContract(c) }
}

export function fieldNames(contract) {
  return contract.fields.map((f) => f.name)
}
