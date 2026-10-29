// lib/contract.js — the project's "口径契约": fields, channels, curated table, gates.
//
// The contract is the single source of truth for what "correct" means in a
// project. It carries no project-specific data of its own, so the plugin stays
// reusable across domains: swap the contract, keep the machinery.
//
// v3 models a project as (read-only sources) + (one workspace SQLite file):
// the contract names the curated table inside that workspace, never a database
// path — there is exactly one place writes can land.
import { RESERVED_TABLES } from './db.js'
import { sha256 } from './util.js'

export const CONTRACT_VERSION = 3

/** SQLite identifiers we are willing to interpolate into DDL. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Deterministic JSON (sorted object keys) for hashing. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

export const contractHash = (contract) => sha256(stableStringify(contract))

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

/**
 * Validate and canonicalize a contract.
 * @returns {{ok:boolean,errors:string[],contract?:object}}
 */
export function validateContract(input) {
  const errors = []
  const c = input && typeof input === 'object' ? structuredClone(input) : null
  if (!c) return { ok: false, errors: ['contract 必须是对象'] }

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

  if (c.channels === undefined) {
    c.channels = [{ name: 'text', method: 'text-extract' }, { name: 'vision', method: 'model-image' }]
  }
  if (!Array.isArray(c.channels) || c.channels.length < 1) {
    errors.push('channels 必须是非空数组')
  } else {
    const chNames = new Set()
    for (const [i, ch] of c.channels.entries()) {
      if (!ch || typeof ch.name !== 'string' || !ch.name.trim()) errors.push(`channels[${i}].name 缺失`)
      else if (chNames.has(ch.name.trim())) errors.push(`通道名重复：${ch.name}`)
      else chNames.add(ch.name.trim())
    }
    if (c.channels.length < 2) errors.push('至少需要两个通道：单通道结果不允许自动采纳')
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
  return { ok: true, errors: [], contract: c }
}

export function fieldNames(contract) {
  return contract.fields.map((f) => f.name)
}
