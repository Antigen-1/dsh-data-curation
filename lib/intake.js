// lib/intake.js — lower the cost of the first step: import record keys from
// CSV/JSONL, derive a pin draft from real samples, and normalize identity
// mappings (rename / exclude / source-file mapping) into one auditable file.
//
// These helpers never sign a pin and never write the workspace database; they
// produce project-relative artifacts under the state directory and leave the
// final "is this contract right?" decision to curation_pin.
import { promises as fs } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { createStore } from './store.js'
import { atomicWrite, csvParse, rowsToObjects, resolveInside, toPosix } from './util.js'

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const KEY_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const fail = (error, extra = {}) => ({ ok: false, error, ...extra })

function requireName(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

function requireTable(table) {
  const value = requireName(table ?? 'main', 'table')
  if (!TABLE_NAME.test(value)) throw new Error(`table 只能用字母、数字、下划线且不能以数字开头：${value}`)
  return value
}

async function loadRows(cwd, relPath, key) {
  const path = requireName(relPath, 'path')
  const abs = resolveInside(cwd, path)
  const ext = path.toLowerCase().slice(path.lastIndexOf('.'))
  if (ext === '.xlsx' || ext === '.xls') {
    throw new Error('暂不支持 Excel 直接导入：请先导出为 CSV 或 JSONL，再运行 curation_records_import')
  }
  if (!['.csv', '.jsonl'].includes(ext)) {
    throw new Error(`记录导入支持 .csv/.jsonl，收到 ${ext || '无扩展名'}`)
  }
  const text = await fs.readFile(abs, 'utf8')
  if (ext === '.jsonl') {
    const rows = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (!line) continue
      let row
      try {
        row = JSON.parse(line)
      } catch (e) {
        throw new Error(`记录源第 ${i + 1} 行无法解析：${e.message}`)
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`记录源第 ${i + 1} 行必须是 JSON 对象`)
      }
      rows.push(row)
    }
    return { rows, key: requireName(key ?? 'record_id', 'key') }
  }
  const table = csvParse(text)
  const header = table[0] ?? []
  if (!header.length) throw new Error('CSV 缺少表头')
  const dupHeader = header.filter((h, i) => header.indexOf(h) !== i)
  if (dupHeader.length) throw new Error(`CSV 表头重复：${[...new Set(dupHeader)].join(', ')}`)
  const keyName = requireName(key ?? header[0], 'key')
  if (!KEY_COLUMN.test(keyName)) throw new Error(`key 列名不合法：${keyName}`)
  if (!header.includes(keyName)) throw new Error(`CSV 缺少键列：${keyName}`)
  return { rows: rowsToObjects(table.slice(1), header), key: keyName }
}

function keyOf(row, key) {
  const raw = row?.[key]
  if (raw === undefined || raw === null) return ''
  return String(raw).trim()
}

function inferFields(rows, key) {
  const names = []
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (name !== key && name !== '__source' && !names.includes(name)) names.push(name)
    }
  }
  return names.map((name) => {
    const values = rows.map((r) => r[name]).filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
    const allNumber = values.length > 0 && values.every((v) => String(v).trim() !== '' && Number.isFinite(Number(v)))
    const allDate = values.length > 0 && values.every((v) => DATE.test(String(v).trim()))
    return {
      name,
      type: allNumber ? 'number' : allDate ? 'date' : 'text',
      allowEmpty: values.length < rows.length,
    }
  })
}

function summarize(rows, key) {
  const seen = new Map()
  let missing = 0
  for (const row of rows) {
    const k = keyOf(row, key)
    if (!k) { missing += 1; continue }
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, count: n })).slice(0, 100)
  return { values: [...seen.keys()], missing, duplicates, duplicateTotal: [...seen.values()].filter((n) => n > 1).length }
}

export async function doRecordsImport({ cwd, stateDir = '.curation', path, key = 'record_id', table = 'main', preview = 10 } = {}) {
  const store = createStore(cwd, stateDir)
  try {
    const tableName = requireTable(table)
    const loaded = await loadRows(cwd, path, key)
    const summary = summarize(loaded.rows, loaded.key)
    if (!summary.values.length) return fail('记录源中没有可用的记录键', { key: loaded.key })
    const fields = inferFields(loaded.rows, loaded.key)
    if (!fields.length) return fail(`记录源除键列 ${loaded.key} 外没有字段`, { key: loaded.key })
    const outAbs = join(store.dir, 'records', `${tableName}.jsonl`)
    await atomicWrite(outAbs, `${loaded.rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
    const rel = toPosix(relative(cwd, outAbs))
    return {
      ok: true,
      table: tableName,
      path: rel,
      key: loaded.key,
      rows: loaded.rows.length,
      count: summary.values.length,
      duplicates: summary.duplicates,
      duplicateTotal: summary.duplicateTotal,
      missing: summary.missing,
      fields,
      records: { kind: 'list', values: summary.values },
      preview: loaded.rows.slice(0, Math.max(0, Math.min(Number(preview) || 10, 50))),
      warnings: [
        ...(summary.missing ? [`${summary.missing} 行没有键值，已跳过`] : []),
        ...(summary.duplicates.length ? [`${summary.duplicateTotal} 个键重复，保留首次出现`] : []),
      ],
    }
  } catch (e) {
    return fail(e.message)
  }
}

export async function doPinDraft({
  cwd, stateDir = '.curation', recordsPath = null, key = 'record_id', table = 'main',
  project = null, channels = null, fields = null, preview = 10,
} = {}) {
  const store = createStore(cwd, stateDir)
  try {
    const tableName = requireTable(table)
    const warnings = []
    let rows = []
    let keyName = requireName(key ?? 'record_id', 'key')
    if (recordsPath) {
      const loaded = await loadRows(cwd, recordsPath, keyName)
      rows = loaded.rows
      keyName = loaded.key
    } else {
      warnings.push('未提供 recordsPath：草稿只含项目级默认和空记录集，请补充记录或直接编辑草稿')
    }
    const summary = summarize(rows, keyName)
    const inferred = fields?.length
      ? fields.map((name) => ({ name: requireName(name, 'field'), type: 'text', allowEmpty: true }))
      : inferFields(rows, keyName)
    if (!inferred.length) warnings.push('没有推断出字段：请在草稿中补充 fields，或提供带表头的 CSV/JSONL')
    if (!summary.values.length) warnings.push('记录集为空：签署前必须补充 records')
    const draft = {
      version: 5,
      project: {
        name: requireName(project ?? basename(cwd) ?? 'curation', 'project'),
        description: '由 curation_pin_draft 根据样本生成，签署前请复核字段与记录集',
      },
      defaults: {
        channels: (channels?.length ? channels : [{ name: 'text' }, { name: 'vision' }]).map((c) => (typeof c === 'string' ? { name: c } : c)),
        evidence: { required: true },
        gates: { minAcceptedRatio: 1 },
      },
      tables: [{
        table: tableName,
        key: keyName,
        records: { kind: 'list', values: summary.values },
        fields: inferred,
      }],
    }
    const outAbs = join(store.dir, 'pin.draft.json')
    await atomicWrite(outAbs, `${JSON.stringify(draft, null, 2)}\n`)
    const rel = toPosix(relative(cwd, outAbs))
    return {
      ok: true,
      draftPath: rel,
      draft,
      fields: inferred.map((f) => f.name),
      records: summary.values.length,
      missing: summary.missing,
      duplicateTotal: summary.duplicateTotal,
      preview: rows.slice(0, Math.max(0, Math.min(Number(preview) || 10, 50))),
      warnings: [
        ...warnings,
        ...(summary.missing ? [`${summary.missing} 行没有键值，已跳过`] : []),
        ...(summary.duplicateTotal ? [`${summary.duplicateTotal} 个键重复，保留首次出现`] : []),
      ],
    }
  } catch (e) {
    return fail(e.message)
  }
}

export async function doIdentity({
  cwd, stateDir = '.curation', path, key = 'record_id', table = 'main',
  rename = {}, exclude = [], fileMap = {}, preview = 10,
} = {}) {
  const store = createStore(cwd, stateDir)
  try {
    const tableName = requireTable(table)
    const loaded = await loadRows(cwd, path, key)
    const renameMap = rename && typeof rename === 'object' && !Array.isArray(rename) ? rename : {}
    const excludeSet = new Set((Array.isArray(exclude) ? exclude : []).map((v) => String(v).trim()).filter(Boolean))
    const fileMapObj = fileMap && typeof fileMap === 'object' && !Array.isArray(fileMap) ? fileMap : {}
    const out = []
    const renamed = []
    const excluded = []
    const mapped = []
    const seen = new Set()
    for (const row of loaded.rows) {
      const original = keyOf(row, loaded.key)
      if (!original) continue
      const next = String(renameMap[original] ?? original).trim()
      if (!next) return fail(`改号后键为空：${original}`)
      if (excludeSet.has(original) || excludeSet.has(next)) { excluded.push(original); continue }
      if (!seen.has(next)) seen.add(next)
      else return fail(`身份归一后出现重复键：${next}`)
      const source = fileMapObj[original] ?? fileMapObj[next]
      const copy = { ...row, [loaded.key]: next }
      if (source) { copy.__source = String(source); mapped.push({ key: next, source: String(source) }) }
      if (next !== original) renamed.push({ from: original, to: next })
      out.push(copy)
    }
    if (!out.length) return fail('身份归一后没有剩余记录')
    const outAbs = join(store.dir, 'records', `${tableName}.jsonl`)
    await atomicWrite(outAbs, `${out.map((r) => JSON.stringify(r)).join('\n')}\n`)
    const auditAbs = join(store.dir, 'identity', `${tableName}.json`)
    const audit = {
      table: tableName,
      key: loaded.key,
      input: String(path),
      count: out.length,
      renamed,
      excluded,
      files: mapped,
      at: new Date().toISOString(),
    }
    await atomicWrite(auditAbs, `${JSON.stringify(audit, null, 2)}\n`)
    return {
      ok: true,
      table: tableName,
      path: toPosix(relative(cwd, outAbs)),
      auditPath: toPosix(relative(cwd, auditAbs)),
      key: loaded.key,
      count: out.length,
      renamed: renamed.length,
      excluded: excluded.length,
      files: mapped.length,
      identity: { renamed, excluded, files: mapped },
      preview: out.slice(0, Math.max(0, Math.min(Number(preview) || 10, 50))),
      warnings: [...(renamed.length ? [`${renamed.length} 个键被改号`] : []), ...(excluded.length ? [`${excluded.length} 条记录被排除`] : [])],
    }
  } catch (e) {
    return fail(e.message)
  }
}

/** Load one channel's submission rows from a file or a directory of files. */
export async function loadSubmissionRows(cwd, from, { key = 'record_id' } = {}) {
  try {
    const target = requireName(from, 'from')
    const abs = resolveInside(cwd, target)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) return fail(`提交文件不存在：${target}`)
    const files = stat.isDirectory()
      ? (await fs.readdir(abs)).filter((f) => /\.(csv|jsonl)$/i.test(f)).sort().map((f) => join(abs, f))
      : [abs]
    if (!files.length) return fail(`目录中没有 CSV/JSONL 文件：${target}`)
    const records = []
    const used = []
    for (const file of files) {
      const rel = toPosix(relative(cwd, file))
      const ext = file.toLowerCase().slice(file.lastIndexOf('.'))
      if (!['.csv', '.jsonl'].includes(ext)) continue
      const loaded = await loadRows(cwd, rel, key)
      for (const row of loaded.rows) {
        const id = keyOf(row, loaded.key)
        if (!id) continue
        const status = ['valid', 'uncertain', 'invalid'].includes(row.status) ? row.status : 'valid'
        let values
        let evidence
        if (row.values && typeof row.values === 'object' && !Array.isArray(row.values)) {
          values = row.values
          evidence = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence : {}
        } else {
          values = {}
          evidence = {}
          for (const [k, v] of Object.entries(row)) {
            if (k === loaded.key || k === 'status' || k === 'record_id' || k === 'record' || k === 'id') continue
            values[k] = v
          }
        }
        records.push({ record_id: id, status, values, evidence })
      }
      used.push(rel)
    }
    if (!records.length) return fail('提交文件中没有可用记录（检查键列和字段）')
    return { ok: true, records, files: used }
  } catch (e) {
    return fail(e.message)
  }
}
