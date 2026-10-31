// lib/core.js — project operations shared by the tools and the slash commands.
//
// A project is (read-only sources) + (one workspace SQLite). Everything the
// tool may change — pins, exporters, submissions, decisions, ledger, the
// curated tables — lives in .curation/project.sqlite. Every mutating step
// re-checks the immutable-source manifest and the pin seal first.
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { adjudicate, summarize } from './adjudicate.js'
import { fieldNames } from './contract.js'
import {
  applyCuration, applyCurationInTx, WRITE_FAILED, loadCurated, readCuratedSafe, resolveRecordIds, sameCell,
} from './delivery.js'
import { backendNames, listExporters, resolveExporter, runExporter } from './exporters.js'
import { buildManifest, verifyManifest } from './manifest.js'
import { buildPack } from './pack.js'
import { runQuery } from './query.js'
import {
  activeTables, buildAggregate, pickTable, pinHash, PIN_VERSION, validatePin,
} from './pin.js'
import {
  createStore, insertDecisionsTx, insertLedgerTx, insertRunTx, writeAppliedTx,
} from './store.js'
import { backupDb, openDb, quoteIdent, withTransaction } from './db.js'
import { readLock, withProjectLock } from './lock.js'
import { ensureDir, newRunId, nowIso, resolveInside, toPosix } from './util.js'

const tail = (s, n = 2000) => (s ? String(s).slice(-n) : '')

export const storeFor = (cwd, stateDir) => createStore(cwd, stateDir)

/**
 * Run one mutating operation under the project lock.
 *
 * Lock contention is an ordinary outcome for the caller (another session is
 * working on this project), so it comes back as `{ ok:false, locked:true }`
 * instead of an exception — tools render it, scripts can retry.
 */
async function locked(store, op, fn, options) {
  try {
    return await withProjectLock(store, op, fn, options)
  } catch (e) {
    if (e?.code === 'CURATION_LOCKED') return { ok: false, locked: true, error: e.message }
    throw e
  }
}

/** Read the source baseline and the stored aggregate pin; collect blockers. */
export async function loadGates(store, { full = false } = {}) {
  const problems = []
  const manifest = await store.readManifest()
  const record = await store.readPinRecord()
  const pin = record?.pin ?? null
  const seal = await store.readPinSeal()

  if (!manifest) problems.push('尚未建立源基线：请先运行 curation_init')
  if (!pin) {
    problems.push('尚未冻结项目 pin：请先运行 curation_pin')
  } else if (!seal) {
    problems.push('pin 缺少封印（pin.sha256）：请重新签署 curation_pin')
  } else {
    const actual = pinHash(pin)
    if (seal !== actual) problems.push('pin 封印与工作区存储不一致：pin 被手工改动，请重新签署 curation_pin')
    if (record.hash !== actual) problems.push('工作区中的 pin 哈希与内容不一致：请重新签署 curation_pin')
    if (pin.version !== PIN_VERSION) problems.push(`pin 版本过旧（v${pin.version}，当前 v${PIN_VERSION}）：请重新签署 curation_pin`)
    for (const t of pin.tables ?? []) {
      const sourceProblem = checkRecordSource(store, { table: t.table, records: t.records })
      if (sourceProblem) problems.push(sourceProblem)
    }
  }

  let manifestCheck = null
  if (manifest) {
    manifestCheck = await verifyManifest(store.cwd, manifest, { reuse: full ? null : manifest })
    if (!manifestCheck.ok) {
      const parts = []
      if (manifestCheck.changed.length) parts.push(`内容变化 ${manifestCheck.changed.length} 个`)
      if (manifestCheck.missing.length) parts.push(`缺失 ${manifestCheck.missing.length} 个`)
      if (manifestCheck.added.length) parts.push(`新增 ${manifestCheck.added.length} 个`)
      problems.push(`源基线漂移（${parts.join('，')}）：立即停止写入并保留现场`)
    }
  }
  return { manifest, pin, record, manifestCheck, problems }
}

/** The read-only record source must never be the workspace database itself. */
function checkRecordSource(store, table) {
  if (table?.records?.kind !== 'db') return null
  try {
    if (resolveInside(store.cwd, table.records.db) === store.dbPath) {
      return `表 ${table.table} 的记录源不能是工作区数据库本身：只读源与可写工作区必须分开`
    }
  } catch (e) {
    return e.message
  }
  return null
}

async function requireGates(store) {
  const gates = await loadGates(store)
  if (gates.problems.length) {
    return { ok: false, error: gates.problems.join('；'), problems: gates.problems, ...gates }
  }
  return { ok: true, ...gates }
}

/** Resolve one table's effective config and its latest stored table_pin row. */
async function tableContext(store, pin, tableId) {
  const picked = pickTable(pin, tableId)
  if (picked.error) return { error: picked.error }
  const row = await store.readTablePin(picked.table.table)
  if (!row) return { error: `表 ${picked.table.table} 还没有 pin 记录：请重新签署 curation_pin` }
  return { table: picked.table, tablePin: row, config: row.config }
}

export async function doInit(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'init', () => doInitLocked(store, args))
}

async function doInitLocked(store, { cwd, sources, force = false, tables = [] }) {
  if (!Array.isArray(sources) || sources.length === 0) return { ok: false, error: 'sources 必须是非空数组' }
  if (!Array.isArray(tables)) return { ok: false, error: 'tables 必须是数组（可预告要登记的表名）' }
  for (const t of tables) {
    if (typeof t !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(t)) {
      return { ok: false, error: `预告表名不合法：${t}` }
    }
  }
  const existing = await store.readManifest()
  if (existing && !force) {
    return { ok: false, error: '源基线已存在。确需重建基线请传 force:true（旧基线与已裁定结果将不可信）' }
  }
  const exclude = [toPosix(relative(cwd, store.dir))]
  const warnings = []
  for (const src of sources) {
    const abs = resolveInside(cwd, src)
    if (abs === store.dir || abs.startsWith(`${store.dir}/`) || store.dir.startsWith(`${abs}/`)) {
      warnings.push(`sources 包含工作区目录 ${exclude[0]}，已从基线排除`)
    }
  }
  const manifest = await buildManifest(cwd, sources, { exclude })
  await store.writeManifest(manifest)
  await store.withDb((db) => {
    const at = nowIso()
    db.prepare(`INSERT INTO project (id, name, description, created_at, updated_at) VALUES (1, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`).run(at, at)
    for (const t of tables) {
      db.prepare(`INSERT INTO table_registry (table_id, delivery_table, purpose, status, created_at, updated_at)
        VALUES (?, ?, NULL, 'active', ?, ?)
        ON CONFLICT(table_id) DO NOTHING`).run(t, t, at, at)
    }
  })
  return {
    ok: true,
    files: manifest.entries.length,
    sha256: manifest.sha256,
    sources: manifest.sources,
    tables,
    excluded: exclude,
    warnings,
    stateDir: store.dir,
    workspace: store.dbPath,
  }
}

export async function doPin(args) {
  const store = storeFor(args.cwd, args.stateDir)
  if (args.dryRun) return doPinLocked(store, args)
  return locked(store, 'pin', () => doPinLocked(store, args))
}

async function doPinLocked(store, { cwd, pin, force = false, dryRun = false, reason = null }) {
  const check = validatePin(pin)
  if (!check.ok) return { ok: false, error: 'pin 校验失败', errors: check.errors }

  const warnings = []
  let recordCount = null
  try {
    recordCount = (await resolveRecordIds(cwd, check.tables[0]?.effective)).length
  } catch (e) {
    warnings.push(`记录集暂时无法解析：${e.message}`)
  }

  // dryRun and signing must hash exactly the same aggregate (raw declarations
  // + registry snapshot), otherwise the pre-sign hash can never equal the seal.
  const aggregate = buildAggregate({
    project: check.pin.project,
    defaults: check.defaults,
    tables: check.tables.map((t) => t.declared),
    registry: check.tables.map((t) => ({ tableId: t.tableId, deliveryTable: t.tableId, status: t.status })),
  })
  const hash = pinHash(aggregate)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      version: PIN_VERSION,
      hash,
      hashKind: 'aggregate',
      declaredHash: pinHash(check.pin),
      project: aggregate.project,
      tables: check.tables.map((t) => ({
        table: t.tableId,
        status: t.status,
        fields: fieldNames(t.effective),
        channels: t.effective.channels.map((c) => c.name),
        hash: t.effectiveHash,
      })),
      records: recordCount,
      warnings,
      pin: aggregate,
    }
  }

  if (!(await store.readManifest())) return { ok: false, error: '尚未建立源基线：请先运行 curation_init' }
  const existing = await store.readPinRecord()
  if (existing && !force) {
    return { ok: false, error: 'pin 已签署。确需重签请传 force:true（已裁定结果需全部重新比对）' }
  }
  if (force && !(typeof reason === 'string' && reason.trim())) {
    return { ok: false, error: 'force 重签必须提供 reason：说明为什么重签（会写入项目事件，供审计）' }
  }

  const registry = await store.listTables()
  const registered = new Set(registry.map((r) => r.tableId))
  const declared = new Set(check.tables.map((t) => t.tableId))
  const omitted = [...registered].filter((id) => !declared.has(id))
  if (omitted.length) {
    return { ok: false, error: `pin 输入省略了已登记的表：${omitted.join(', ')}。请显式保留（status active）或退役（status retired），不得静默删除` }
  }

  const pinId = `pin-${Date.now().toString(36)}-${newRunId().slice(-6)}`
  await store.writePin({
    pin: aggregate, pinId, hash, tables: check.tables, project: aggregate.project,
    reason: reason?.trim() ?? null,
  })
  return {
    ok: true,
    version: PIN_VERSION,
    pinId,
    hash,
    project: check.pin.project,
    tables: check.tables.map((t) => ({
      table: t.tableId,
      status: t.status,
      fields: fieldNames(t.effective),
      channels: t.effective.channels.map((c) => c.name),
      hash: t.effectiveHash,
    })),
    records: recordCount,
    warnings,
    stateDir: store.dir,
    workspace: store.dbPath,
  }
}

export async function doSubmit(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'submit', () => doSubmitLocked(store, args))
}

async function doSubmitLocked(store, { channel, batch, records, meta, table }) {
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const ctx = await tableContext(store, gates.pin, table)
  if (ctx.error) return { ok: false, error: ctx.error }
  const config = ctx.config
  if (!batch) return { ok: false, error: 'batch 必填（批次号，例如 B001）' }
  if (!config.channels.some((c) => c.name === channel)) {
    return { ok: false, error: `未声明的通道：${channel}（表 ${ctx.table.table} 通道：${config.channels.map((c) => c.name).join(', ')}）` }
  }
  if (!Array.isArray(records) || records.length === 0) return { ok: false, error: 'records 必须是非空数组' }

  const known = new Set(fieldNames(config))
  const unknownFields = new Set()
  const badRecords = []
  const clean = []
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') { badRecords.push('记录不是对象'); continue }
    const id = rec.record_id ?? rec.record ?? rec.id
    if (id === undefined || id === null || String(id) === '') { badRecords.push('记录缺少 record_id'); continue }
    const status = rec.status ?? 'valid'
    if (!['valid', 'uncertain', 'invalid'].includes(status)) {
      badRecords.push(`${id}: status 只能是 valid/uncertain/invalid`)
      continue
    }
    const values = {}
    for (const [k, v] of Object.entries(rec.values ?? {})) {
      if (!known.has(k)) { unknownFields.add(k); continue }
      values[k] = v === null || v === undefined ? '' : String(v)
    }
    const evidence = {}
    for (const [k, v] of Object.entries(rec.evidence ?? {})) {
      if (!known.has(k) || !v || typeof v !== 'object') continue
      evidence[k] = {
        page: v.page === undefined || v.page === null ? null : Number(v.page),
        quote: v.quote === undefined || v.quote === null ? null : String(v.quote).slice(0, 500),
      }
    }
    clean.push({ record_id: String(id), status, values, evidence })
  }
  if (unknownFields.size) {
    return { ok: false, error: `提交中出现契约未声明的字段：${[...unknownFields].join(', ')}（拒绝整批，避免静默丢数据）` }
  }
  if (badRecords.length) {
    return { ok: false, error: '记录结构不合法，拒绝整批', errors: badRecords.slice(0, 20) }
  }
  const seenIds = new Set()
  const duplicateIds = new Set()
  for (const rec of clean) {
    if (seenIds.has(rec.record_id)) duplicateIds.add(rec.record_id)
    seenIds.add(rec.record_id)
  }
  if (duplicateIds.size) {
    return { ok: false, error: `批次内重复记录：${[...duplicateIds].join(', ')}（同一批每个记录键只能出现一次）` }
  }
  const count = await store.insertSubmissions({
    tableId: ctx.table.table, channel, batch, records: clean, notes: meta?.notes ?? null,
  })
  return { ok: true, table: ctx.table.table, channel, batch, records: count, storedIn: store.dbPath }
}

/** Compare every cell across channels and record one decision per cell. */
export async function doCompare(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'compare', () => doCompareLocked(store, args))
}

async function doCompareLocked(store, { cwd, records, fields, scope = 'auto', table }) {
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const ctx = await tableContext(store, gates.pin, table)
  if (ctx.error) return { ok: false, error: ctx.error }
  const config = ctx.config
  const tableId = ctx.table.table

  const allRecordIds = await resolveRecordIds(cwd, config)
  let recordIds = allRecordIds
  if (Array.isArray(records) && records.length) {
    const known = new Set(allRecordIds)
    const unknown = records.filter((r) => !known.has(String(r)))
    if (unknown.length) return { ok: false, error: `记录不在契约记录集中：${unknown.slice(0, 10).join(', ')}` }
    recordIds = records.map(String)
  }
  if (Array.isArray(fields) && fields.length) {
    const known = new Set(fieldNames(config))
    const unknown = fields.filter((f) => !known.has(f))
    if (unknown.length) return { ok: false, error: `契约中没有这些字段：${unknown.join(', ')}` }
  }
  if (scope !== 'auto' && scope !== 'all') {
    return { ok: false, error: `scope 只能是 auto 或 all：${scope}` }
  }

  const flat = await store.latestSubmissions(tableId)
  const byRecord = new Map()
  for (const row of flat) {
    if (!byRecord.has(row.record)) byRecord.set(row.record, [])
    const list = byRecord.get(row.record)
    let sub = list.find((s) => s.channel === row.channel)
    if (!sub) {
      sub = {
        channel: row.channel,
        batch: row.batch,
        record_id: row.record,
        status: row.status,
        submittedAt: row.submittedAt,
        values: {},
        evidence: {},
      }
      list.push(sub)
    }
    sub.values[row.field] = row.value
    sub.evidence[row.field] = row.evidence
  }
  const usedChannels = [...new Set(flat.map((s) => s.channel))].sort()
  if (usedChannels.length < 2) {
    return {
      ok: false,
      error: `目前只有 ${usedChannels.length} 个通道有提交（${usedChannels.join(', ') || '无'}）；至少需要两个独立通道`,
    }
  }

  const pinId = gates.record.id
  const chosenFields = fields?.length ? fields : fieldNames(config)
  const lastRun = await store.latestRun('compare', tableId)
  const samePin = lastRun?.summary?.pinId === pinId
  let cells = null
  let skippedCells = 0
  if (scope === 'all' || !samePin) {
    // full pass
  } else {
    const stale = await store.staleCells({ tableId, records: recordIds, fields: chosenFields })
    const covered = new Set(recordIds)
    cells = stale.filter((c) => covered.has(c.record))
    skippedCells = recordIds.length * chosenFields.length - cells.length
    if (cells.length === 0) {
      return {
        ok: true, skipped: true, scope, runId: null, table: tableId,
        records: recordIds.length, fields: chosenFields.length, channels: usedChannels,
        recomputed: 0, skippedCells, accepted: 0, pending: 0, synthesized: 0, byReason: {},
        workspace: store.dbPath,
      }
    }
  }

  const decisions = adjudicate({ contract: config, recordIds, fields, submissionsByRecord: byRecord, root: store.cwd, cells })
  const runId = newRunId()
  const stats = summarize(decisions)
  const pendingItems = decisions
    .filter((d) => d.status !== 'accepted')
    .map((d) => ({
      table: tableId,
      record: d.record,
      field: d.field,
      reason: d.reason,
      votes: (d.votes ?? []).map((v) => ({ channel: v.channel, valid: v.valid, present: v.present, raw: v.raw })),
    }))

  await store.withDb((db) => withTransaction(db, () => {
    insertDecisionsTx(db, {
      tableId, runId, pinId, tablePinId: ctx.tablePin.id, decisions,
    })
    insertRunTx(db, {
      runId,
      kind: 'compare',
      summary: {
        table: tableId, scope: cells ? 'auto' : 'all', recomputed: decisions.length,
        skippedCells, pinId, records: recordIds.length, fields: chosenFields.length,
        channels: usedChannels, accepted: stats.accepted, pending: stats.pending,
        synthesized: stats.synthesized, byReason: stats.byReason,
      },
      tables: [{ tableId, pinId, summary: { table: tableId, pinId, scope: cells ? 'auto' : 'all', recomputed: decisions.length, accepted: stats.accepted, pending: stats.pending } }],
    })
  }))
  await store.writePending(runId, pendingItems)
  return {
    ok: true, runId, table: tableId, scope: cells ? 'auto' : 'all',
    records: recordIds.length, fields: chosenFields.length, channels: usedChannels,
    recomputed: decisions.length, skippedCells, ...stats, workspace: store.dbPath,
  }
}

export async function doApply(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'apply', () => doApplyLocked(store, args))
}

async function doApplyLocked(store, { dryRun = false, table }) {
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const ctx = await tableContext(store, gates.pin, table)
  if (ctx.error) return { ok: false, error: ctx.error }
  const config = ctx.config
  const tableId = ctx.table.table
  const delivery = config.delivery
  const fields = config.fields

  const latest = await store.latestDecisions(tableId)
  if (!latest.length) return { ok: false, error: '没有比对记录：请先运行 curation_compare' }
  const accepted = latest.filter((d) => d.status === 'accepted')
  if (!accepted.length) return { ok: false, error: '没有任何被两个通道一致确认的格子，未写入' }
  const stalePin = accepted.filter((d) => d.pin_id !== gates.record.id)
  if (stalePin.length) {
    return {
      ok: false,
      error: `有 ${stalePin.length} 个接受格来自旧版 pin：落表前必须用当前 pin 重新比对（curation_compare scope="all"）`,
    }
  }

  const ops = accepted.map((d) => ({
    record: String(d.record),
    field: d.field,
    value: d.value === null || d.value === undefined ? '' : String(d.value),
  }))
  const decisionIds = new Map(accepted.map((d) => [`${d.record}\u0000${d.field}`, d.id]))

  await ensureDir(store.backupsDir)
  const stamp = nowIso().replace(/[:.]/g, '-')
  const backupPath = join(store.backupsDir, `${stamp}__project.sqlite`)
  const appliedAt = nowIso()
  const applyRunId = newRunId()
  let backup = null
  let outcome
  try {
    outcome = await store.withDb((db) => {
      const before = loadCurated(db, delivery)
      if (!dryRun) backup = backupDb(db, backupPath)
      if (dryRun) {
        return { result: applyCuration({ db, delivery, fields, ops, dryRun: true }), before }
      }
      const result = withTransaction(db, () => {
        const written = applyCurationInTx({ db, delivery, fields, ops })
        insertLedgerTx(db, tableId, accepted.map((d) => {
          const previous = before.get(String(d.record))
          return {
            applied_at: appliedAt,
            record: String(d.record),
            field: d.field,
            old: previous ? (previous[d.field] ?? null) : null,
            new: String(d.value ?? ''),
            adopted: d.adopted,
            dissent: d.dissent ?? [],
            evidence: d.evidence ?? [],
            run_id: d.run_id,
            decision_id: d.id ?? decisionIds.get(`${d.record}\u0000${d.field}`) ?? null,
            apply_run_id: applyRunId,
          }
        }))
        writeAppliedTx(db, {
          runId: applyRunId,
          appliedAt,
          ops: ops.length,
          backup,
          deliveryTable: delivery.table,
          tables: [{ tableId, ops: ops.length, deliveryTable: delivery.table }],
        })
        return written
      })
      return { result, before }
    })
  } catch (e) {
    if (e?.code === WRITE_FAILED) return { ok: false, error: '写入失败', errors: e.errors }
    if (e?.errcode !== undefined || String(e?.code ?? '').startsWith('ERR_SQLITE')) {
      return { ok: false, error: '写入失败', errors: [String(e.message ?? e)] }
    }
    throw e
  }
  if (!outcome.result.ok) return { ok: false, error: '写入失败', errors: outcome.result.errors }
  return {
    ok: true, dryRun, table: tableId, applied: outcome.result.applied, backup,
    delivery: delivery.table, workspace: store.dbPath,
    created: outcome.result.created ?? false,
    addedColumns: outcome.result.addedColumns ?? [],
    warnings: outcome.result.warnings ?? [],
    sample: ops.slice(0, 5),
  }
}

/** Export curated tables through a registered or project-defined exporter. */
export async function doExport({ cwd, stateDir, format = 'csv', out = null, table = null, includeRetired = false }) {
  const store = storeFor(cwd, stateDir)
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const pin = gates.pin
  let entries
  if (table) {
    const found = (pin.tables ?? []).find((t) => t.table === table)
    if (!found) return { ok: false, error: `pin 中没有这张表：${table}（可用：${(pin.tables ?? []).map((t) => t.table).join(', ')}）` }
    entries = [found]
  } else {
    entries = (pin.tables ?? []).filter((t) => (t.status ?? 'active') === 'active' || includeRetired)
  }
  if (!entries.length) return { ok: false, error: '没有可导出的表（全部退役或未登记）' }

  const external = Object.fromEntries((await store.listExporters())
    .map((e) => [e.name, { command: e.command, args: e.args }]))
  let exporter
  try {
    exporter = resolveExporter(format, external)
  } catch (e) {
    return { ok: false, error: e.message }
  }
  const stamp = nowIso().replace(/[:.]/g, '-')
  const preloaded = []
  for (const entry of entries) {
    const tablePin = await store.readTablePin(entry.table)
    if (!tablePin) return { ok: false, error: `表 ${entry.table} 还没有 pin 记录` }
    const delivery = tablePin.config.delivery
    if (format === 'sqlite' && entries.length > 1) {
      preloaded.push({ entry, tablePin, delivery, curated: await store.withDb((db) => readCuratedSafe(db, delivery)) })
      continue
    }
    const curated = await store.withDb((db) => readCuratedSafe(db, delivery))
    if (!curated) return { ok: false, error: `交付表尚未生成：${delivery.table}（先运行 curation_apply）` }
    preloaded.push({ entry, tablePin, delivery, curated })
  }
  if (format === 'sqlite' && entries.length > 1) {
    const missing = preloaded.filter((p) => !p.curated).map((p) => p.delivery.table)
    if (missing.length) return { ok: false, error: `交付表尚未生成：${missing.join(', ')}（先运行 curation_apply）` }
    const dir = join(store.dir, 'exports')
    await ensureDir(dir)
    const target = out ? resolveInside(cwd, out) : join(dir, `curated-${stamp}.sqlite`)
    await writeCuratedSnapshot(target, preloaded)
    return {
      ok: true, format, kind: 'sqlite', tables: preloaded.map((p) => p.delivery.table),
      path: toPosix(target), workspace: store.dbPath,
      results: preloaded.map((p) => ({ table: p.delivery.table, path: toPosix(target), rows: p.curated.rows.length, columns: p.curated.header.length })),
    }
  }
  if (entries.length > 1) {
    return { ok: false, error: `工作区有 ${entries.length} 张表：单表格式请用 table 指定一张（或 format="sqlite" 一次导出全部）` }
  }

  const only = preloaded[0]
  let target
  if (out) target = resolveInside(cwd, out)
  else {
    const dir = join(store.dir, 'exports')
    await ensureDir(dir)
    target = join(dir, `${only.delivery.table}-${stamp}.${exporter.extension}`)
  }
  const config = only.tablePin.config
  const result = await runExporter(format, {
    contract: config, external, cwd, table: only.delivery.table, key: only.delivery.key,
    columns: only.curated.header, rows: only.curated.rows, fields: config.fields, out: target,
  })
  const entryResult = {
    ok: true, format, kind: result.kind ?? exporter.kind, table: only.delivery.table,
    path: toPosix(target), rows: result.rows ?? only.curated.rows.length,
    columns: result.columns ?? only.curated.header.length, workspace: store.dbPath,
  }
  return { ...entryResult, results: [{ table: only.delivery.table, path: entryResult.path, rows: entryResult.rows, columns: entryResult.columns }] }
}

/** Write one snapshot database with every curated table (multi-table sqlite export). */
async function writeCuratedSnapshot(target, tables) {
  await ensureDir(dirname(target))
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await fs.rm(tmp, { force: true })
  const db = openDb(tmp)
  try {
    withTransaction(db, () => {
      for (const { delivery, curated, tablePin } of tables) {
        const header = curated.header
        const fieldByName = new Map((tablePin.config.fields ?? []).map((f) => [f.name, f]))
        const cols = header.map((c) => (c === delivery.key
          ? `${quoteIdent(c)} TEXT PRIMARY KEY`
          : `${quoteIdent(c)} ${fieldByName.get(c)?.type === 'number' ? 'REAL' : 'TEXT'}`))
        db.exec(`CREATE TABLE ${quoteIdent(delivery.table)} (${cols.join(', ')})`)
        const stmt = db.prepare(`INSERT INTO ${quoteIdent(delivery.table)} (${header.map(quoteIdent).join(', ')}) VALUES (${header.map(() => '?').join(', ')})`)
        for (const row of curated.rows) stmt.run(...header.map((c) => (row[c] === '' || row[c] === undefined ? null : row[c])))
      }
    })
  } finally {
    db.close()
  }
  await fs.rename(tmp, target)
}

/** List, add or remove project-level exporters (stored in the workspace). */
export async function doExporter(args) {
  const store = storeFor(args.cwd, args.stateDir)
  const op = args.action === 'list' ? null : 'exporter'
  if (!op) return doExporterLocked(store, args)
  return locked(store, op, () => doExporterLocked(store, args))
}

async function doExporterLocked(store, { action = 'list', name, command, args = [] }) {
  if (action === 'list') {
    return { ok: true, builtins: listExporters(), project: await store.listExporters(), workspace: store.dbPath }
  }
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name 必填' }
  if (backendNames().includes(name)) {
    return { ok: false, error: `${name} 是内置导出格式，项目导出器不能覆盖内置名称` }
  }
  if (action === 'add') {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) {
      return { ok: false, error: 'name 只能用字母开头，字母数字_-，最长 32' }
    }
    if (typeof command !== 'string' || !command.trim()) {
      return { ok: false, error: 'command 必填：在项目根目录经 shell 执行的命令（写出 $CURATION_EXPORT_OUT）' }
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return { ok: false, error: 'args 必须是字符串数组' }
    }
    await store.upsertExporter({ name, command, args })
    return { ok: true, action: 'add', name, command, args, workspace: store.dbPath }
  }
  if (action === 'remove') {
    const removed = await store.removeExporter(name)
    return { ok: true, action: 'remove', name, removed, workspace: store.dbPath }
  }
  return { ok: false, error: 'action 只支持 list、add、remove' }
}

/** Package the project (workspace snapshot + pin + referenced scripts). */
export async function doPack(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'pack', () => doPackLocked(store, args), { ttlMs: 20 * 60 * 1000 })
}

async function doPackLocked(store, { cwd, out = null, label = null }) {
  const target = out ? resolveInside(cwd, out) : null
  return buildPack(store, { out: target, label })
}

function runVerifyCmd(cwd, cmd, tableId) {
  if (!cmd) return null
  const r = spawnSync(cmd, {
    cwd, shell: true, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 8 << 20,
    env: { ...process.env, CURATION_TABLE: tableId ?? '' },
  })
  return { cmd, exitCode: r.status ?? -1, signal: r.signal ?? null, stdout: tail(r.stdout), stderr: tail(r.stderr) }
}

/**
 * Read-only query over the workspace. No lock, no gates, no writes: it only
 * needs the workspace file to exist. Used to replace ad-hoc `sqlite3` access.
 */
export async function doQuery({ cwd = process.cwd(), stateDir, what, ...filters } = {}) {
  const store = storeFor(cwd, stateDir)
  let db = null
  try {
    await fs.access(store.dbPath)
  } catch {
    return { ok: false, error: '工作区尚未建立：先运行 curation_init' }
  }
  try {
    db = openDb(store.dbPath, { readOnly: true })
    const data = runQuery(db, { what, ...filters })
    return { ok: true, what, workspace: store.dbPath, data }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** Append a free-form note to the project or one table (append-only event). */
export async function doNote({ cwd = process.cwd(), stateDir, text, table = null } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: 'note 内容不能为空' }
  const store = storeFor(cwd, stateDir)
  try {
    await fs.access(store.manifestPath)
  } catch {
    return { ok: false, error: '项目尚未初始化：先运行 curation_init' }
  }
  if (table) {
    const known = await store.listTables()
    if (!known.some((row) => row.tableId === table)) {
      return { ok: false, error: `表未登记：${table}（先运行 curation_init 预告，或 curation_pin 登记）` }
    }
  }
  const pinRecord = await store.readPinRecord()
  const info = await store.addNote({ tableId: table ?? null, text: body, pinId: pinRecord?.id ?? null })
  return { ok: true, scope: table ? 'table' : 'project', table: table ?? null, at: info.at, pinId: info.pinId ?? null }
}

export async function doVerify(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'verify', () => doVerifyLocked(store, args), { ttlMs: 25 * 60 * 1000 })
}

async function verifyTable(store, cwd, tableId, gates) {
  const checks = []
  const add = (name, ok, detail, severity = 'fail') => checks.push({ name, status: ok ? 'pass' : severity, detail })
  const tablePin = await store.readTablePin(tableId)
  if (!tablePin) {
    add('table_pin_present', false, `表 ${tableId} 还没有 pin 记录：请重新签署 curation_pin`)
    return { table: tableId, status: 'FAIL', checks, accepted: 0, pending: 0, total: 0, pendingByReason: {}, verifyCmd: null, revision: null }
  }
  const config = tablePin.config
  const delivery = config.delivery
  const fields = fieldNames(config)
  const recordIds = []
  try {
    const ids = await resolveRecordIds(cwd, config)
    recordIds.push(...ids)
    add('records_resolvable', ids.length > 0, `表 ${tableId}：记录 ${ids.length} 条`)
  } catch (e) {
    add('records_resolvable', false, e.message)
  }

  const latest = await store.latestDecisions(tableId)
  const cellKey = (record, field) => `${record}\u0000${field}`
  const byCell = new Map(latest.map((d) => [cellKey(d.record, d.field), d]))
  const accepted = latest.filter((d) => d.status === 'accepted')
  const pending = latest.filter((d) => d.status !== 'accepted')
  const total = recordIds.length * fields.length
  const currentPin = gates.record.id
  const stalePin = latest.filter((d) => d.pin_id !== currentPin)

  const missingCells = []
  for (const record of recordIds) for (const field of fields) if (!byCell.has(cellKey(record, field))) missingCells.push(`${record}.${field}`)
  add('coverage', missingCells.length === 0 && stalePin.length === 0, stalePin.length
    ? `${stalePin.length} 格来自旧 pin，需要重新比对`
    : missingCells.length
      ? `未处理 ${missingCells.length}/${total} 格，例如 ${missingCells.slice(0, 5).join(', ')}`
      : `${total}/${total} 格都有当前 pin 的比对记录`)

  const weak = accepted.filter((d) => !Array.isArray(d.adopted) || d.adopted.length < 2)
  add('accepted_two_channels', weak.length === 0, weak.length ? `${weak.length} 格接受结果不足两个一致通道` : '所有接受结果均有两个一致通道')

  const noEvidence = accepted.filter((d) => {
    if (d.normalized === '') return false
    return !(d.evidence ?? []).some((e) => e.page !== null || e.quote)
  })
  if (config.evidence?.required === false) {
    add('evidence_present', true, '契约不要求证据（evidence.required = false）')
  } else {
    add('evidence_present', noEvidence.length === 0, noEvidence.length ? `${noEvidence.length} 格缺少页码或原文证据` : '接受格均有证据')
  }

  let curated = null
  try {
    curated = await store.withDb((db) => readCuratedSafe(db, delivery))
  } catch (e) {
    add('delivery_matches', false, e.message)
  }
  if (curated) {
    const byKey = new Map(curated.rows.map((r) => [String(r[delivery.key]), r]))
    const fieldByName = new Map(config.fields.map((f) => [f.name, f]))
    const missingRecords = recordIds.filter((id) => !byKey.has(id))
    const mismatches = accepted.filter((d) => {
      const row = byKey.get(String(d.record))
      return !row || !sameCell(fieldByName.get(d.field), row[d.field] ?? '', d.value ?? '')
    })
    add('delivery_matches', missingRecords.length === 0 && mismatches.length === 0,
      missingRecords.length === 0 && mismatches.length === 0
        ? `${delivery.table} 与 ${accepted.length} 个接受格一致`
        : `记录缺失 ${missingRecords.length}，值不一致 ${mismatches.length}`)
  } else if (checks.every((c) => c.name !== 'delivery_matches')) {
    add('delivery_matches', false, `交付表尚未生成：${delivery.table}（先运行 curation_apply）`)
  }

  const runIds = [...new Set(latest.map((d) => d.run_id).filter(Boolean))]
  const missingRuns = []
  for (const rid of runIds) if (!(await store.getRun(rid))) missingRuns.push(rid)
  add('decision_runs_recorded', missingRuns.length === 0,
    missingRuns.length ? `比对引用了不存在的运行记录：${missingRuns.slice(0, 5).join(', ')}` : `${runIds.length} 次比对均有运行快照`)

  const ledger = await store.latestLedger(tableId)
  const ledgerKeys = new Set(ledger.map((r) => `${r.record}\u0000${r.field}\u0000${r.new_value ?? ''}`))
  const noLedger = accepted.filter((d) => !ledgerKeys.has(`${d.record}\u0000${d.field}\u0000${String(d.value ?? '')}`))
  add('ledger_complete', noLedger.length === 0, noLedger.length ? `${noLedger.length} 个接受格没有落表留痕` : `留痕 ${ledger.length} 行`)

  const ratio = total ? accepted.length / total : 0
  const minRatio = config.gates?.minAcceptedRatio ?? 0
  add('accept_ratio', ratio >= minRatio, `接受比例 ${(ratio * 100).toFixed(2)}% / 门槛 ${(minRatio * 100).toFixed(0)}%`)

  if (pending.length) {
    add('pending_cells', false, `${pending.length} 格待裁定（未自动改表，不计为已核实）`, 'conditional')
  } else {
    add('pending_cells', true, '无待裁定格')
  }

  const verifyCmd = runVerifyCmd(cwd, config.gates?.verifyCmd, tableId)
  if (verifyCmd) add('verify_cmd', verifyCmd.exitCode === 0, `${verifyCmd.cmd} → exit ${verifyCmd.exitCode}`)

  const failed = checks.filter((c) => c.status === 'fail')
  const conditional = checks.filter((c) => c.status === 'conditional')
  const status = failed.length ? 'FAIL' : conditional.length ? 'CONDITIONAL' : 'PASS'
  const pendingByReason = {}
  for (const d of pending) {
    const key = d.reason ?? 'unknown'
    pendingByReason[key] = (pendingByReason[key] ?? 0) + 1
  }
  return {
    ok: status === 'PASS', status, table: tableId, checks,
    accepted: accepted.length, pending: pending.length, pendingByReason, total,
    verifyCmd, problems: gates.problems,
  }
}


const worstStatus = (statuses) => (statuses.includes('FAIL') ? 'FAIL' : statuses.includes('CONDITIONAL') ? 'CONDITIONAL' : 'PASS')

/**
 * Verify one table (`table`) or every active table (no `table`). Project-level
 * checks run once; table checks run per table; the project result is the
 * conjunction of all of them (FAIL > CONDITIONAL > PASS).
 */
async function doVerifyLocked(store, { cwd, table = null, includeRetired = false }) {
  const gates = await loadGates(store, { full: true })
  const projectChecks = []
  const add = (name, ok, detail, severity = 'fail') => projectChecks.push({ name, status: ok ? 'pass' : severity, detail })

  add('state_present', Boolean(gates.manifest && gates.pin), gates.manifest && gates.pin ? '基线与 pin 存在' : '缺少基线或 pin')
  const seal = await store.readPinSeal()
  add('pin_intact', Boolean(gates.pin) && Boolean(seal) && seal === pinHash(gates.pin), 'pin 封印与工作区存储一致')
  add('manifest_intact', Boolean(gates.manifestCheck?.ok), gates.manifestCheck
    ? `检查 ${gates.manifestCheck.checked} 个源文件：变化 ${gates.manifestCheck.changed.length}，缺失 ${gates.manifestCheck.missing.length}，新增 ${gates.manifestCheck.added.length}`
    : '无基线')

  const migrationPending = (await store.getMeta('migration_pending')) === '1'
  add('migration_pending', !migrationPending,
    migrationPending ? '迁移占位 pin 尚未重签：请 curation_pin 重签完善 project/records，然后重新 compare/apply' : '无迁移中间态',
    'conditional')

  let schemaOk = false
  let schemaDetail = ''
  try {
    const dbVersion = await store.withDb((db) => Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0))
    const head = await fs.readFile(store.schemaPath, 'utf8')
    schemaOk = head.includes(`user_version=${dbVersion}`)
    schemaDetail = schemaOk
      ? `schema.sql 与 user_version=${dbVersion} 一致`
      : `schema.sql 头与当前 user_version=${dbVersion} 不一致（派生物，下次打开工作区会重建）`
  } catch (e) {
    schemaDetail = `schema.sql 尚未生成：${e.message}`
  }
  add('schema_snapshot', schemaOk, schemaDetail, 'conditional')

  const project = { checks: projectChecks }
  if (!gates.pin) {
    return { ok: false, status: 'FAIL', checks: projectChecks, project, tables: [], problems: gates.problems }
  }

  let chosen
  if (table) {
    const found = (gates.pin.tables ?? []).find((t) => t.table === table)
    if (!found) {
      const err = `pin 中没有这张表：${table}（可用：${(gates.pin.tables ?? []).map((t) => t.table).join(', ')}）`
      projectChecks.push({ name: 'table_context', status: 'fail', detail: err })
      return { ok: false, status: 'FAIL', checks: projectChecks, project, tables: [], problems: [...gates.problems, err] }
    }
    if ((found.status ?? 'active') === 'retired' && !includeRetired) {
      const err = `表 ${table} 已退役：只读。查看历史结果请传 includeRetired:true`
      projectChecks.push({ name: 'table_context', status: 'fail', detail: err })
      return { ok: false, status: 'FAIL', checks: projectChecks, project, tables: [], problems: [...gates.problems, err] }
    }
    chosen = [table]
  } else {
    chosen = (gates.pin.tables ?? []).filter((t) => (t.status ?? 'active') === 'active').map((t) => t.table)
  }
  if (!chosen.length) {
    projectChecks.push({ name: 'tables_present', status: 'fail', detail: '没有可验收的表（全部退役或未登记）' })
    return { ok: false, status: 'FAIL', checks: projectChecks, project, tables: [], problems: gates.problems }
  }

  const tables = []
  for (const tid of chosen) tables.push(await verifyTable(store, cwd, tid, gates))
  const status = worstStatus([...projectChecks.map((c) => (c.status === 'pass' ? 'PASS' : c.status === 'conditional' ? 'CONDITIONAL' : 'FAIL')), ...tables.map((t) => t.status)])
  const single = tables.length === 1 ? tables[0] : null
  const checks = single
    ? [...projectChecks, ...single.checks]
    : [...projectChecks, ...tables.flatMap((t) => t.checks.map((c) => ({ ...c, name: `${t.table}.${c.name}` })))]
  return {
    ok: status === 'PASS', status, checks, project, tables,
    ...(single ? { table: single.table, accepted: single.accepted, pending: single.pending, pendingByReason: single.pendingByReason, total: single.total, verifyCmd: single.verifyCmd } : {}),
    problems: gates.problems,
  }
}

export async function doStatus({ cwd, stateDir }) {
  const store = storeFor(cwd, stateDir)
  const manifest = await store.readManifest()
  const record = await store.readPinRecord()
  const pin = record?.pin ?? null
  const project = await store.readProject()
  const tables = await store.listTables()
  const channelStats = await store.channelStats()
  const latest = await store.withDb((db) => db.prepare(`
    SELECT d.* FROM decision d JOIN (SELECT MAX(id) AS id FROM decision GROUP BY table_id, record, field) m ON d.id = m.id
  `).all().map((r) => ({ ...r, synthesized: Boolean(r.synthesized) })))
  const accepted = latest.filter((d) => d.status === 'accepted')
  const pending = latest.filter((d) => d.status !== 'accepted')
  const reasons = {}
  for (const d of pending) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
  const synthesized = accepted.filter((d) => d.synthesized).length
  const runs = await store.runStats()
  const tableInfo = []
  for (const t of tables) {
    const curated = t.config?.delivery ? await store.withDb((db) => readCuratedSafe(db, t.config.delivery)) : null
    tableInfo.push({
      table: t.tableId,
      status: t.status,
      purpose: t.purpose,
      revision: t.revision ?? null,
      pinHash: t.hash ?? null,
      fields: t.config?.fields?.length ?? 0,
      channels: t.config?.channels?.map((c) => c.name) ?? [],
      key: t.config?.delivery?.key ?? null,
      rows: curated ? curated.rows.length : null,
      columns: curated ? curated.header.length : null,
    })
  }
  const readMetaJson = async (key) => {
    const raw = await store.getMeta(key)
    if (!raw) return []
    try { return JSON.parse(raw) } catch { return [] }
  }
  const migration = {
    pending: (await store.getMeta('migration_pending')) === '1',
    at: await store.getMeta('migration_at'),
    recordsAdded: await readMetaJson('migration_records_added'),
    recordsRemoved: await readMetaJson('migration_records_removed'),
  }
  return {
    ok: Boolean(manifest && pin),
    stateDir: store.dir,
    workspace: store.dbPath,
    manifest: manifest ? { files: manifest.entries.length, sha256: manifest.sha256, createdAt: manifest.createdAt, sources: manifest.sources } : null,
    project: project ? { name: project.name, description: project.description } : null,
    pin: pin
      ? {
          version: pin.version,
          id: record.id,
          hash: record.hash,
          algorithm: record.algorithm,
          pinnedAt: record.pinnedAt,
          defaults: pin.defaults ?? {},
          tables: pin.tables?.length ?? 0,
        }
      : null,
    tables: tableInfo,
    exporters: { builtins: listExporters(), project: await store.listExporters() },
    channels: channelStats,
    runs,
    decisions: { total: latest.length, accepted: accepted.length, pending: pending.length, synthesized, byReason: reasons },
    applied: await store.readApplied(),
    migration,
    pendingFile: store.pendingPath,
    lock: await readLock(store),
  }
}

/** Compact plan of what a next compare would cover (no writes). */
export async function coveragePreview(cwd, stateDir, table = null) {
  const store = storeFor(cwd, stateDir)
  const record = await store.readPinRecord()
  if (!record) return null
  const ctx = await tableContext(store, record.pin, table)
  if (ctx.error) return null
  const recordIds = await resolveRecordIds(cwd, ctx.config)
  return {
    table: ctx.table.table,
    records: recordIds.length,
    fields: fieldNames(ctx.config).length,
    cells: recordIds.length * fieldNames(ctx.config).length,
    channels: ctx.config.channels.map((c) => c.name),
    delivery: ctx.config.delivery,
    pinId: record.id,
    pinHash: record.hash,
  }
}

export { activeTables }
