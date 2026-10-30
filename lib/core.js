// lib/core.js — project operations shared by the tools and the slash commands.
//
// A project is (read-only sources) + (one workspace SQLite). Everything the
// tool may change — contract, exporters, submissions, decisions, ledger, the
// curated table — lives in .curation/project.sqlite. Every mutating step
// re-checks the immutable-source manifest and the contract seal first.
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import { adjudicate, summarize } from './adjudicate.js'
import { CONTRACT_VERSION, contractHash, fieldNames, validateContract } from './contract.js'
import {
  applyCuration, applyCurationInTx, WRITE_FAILED, loadCurated, readCuratedSafe, resolveRecordIds, sameCell,
} from './delivery.js'
import { backendNames, listExporters, resolveExporter, runExporter } from './exporters.js'
import { buildManifest, verifyManifest } from './manifest.js'
import { buildPack } from './pack.js'
import { runQuery } from './query.js'
import {
  createStore, insertDecisionsTx, insertLedgerTx, insertRunTx, writeAppliedTx,
} from './store.js'
import { backupDb, openDb, withTransaction } from './db.js'
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

/** Read the source baseline and the stored contract; collect blocking problems. */
export async function loadGates(store, { full = false } = {}) {
  const problems = []
  const manifest = await store.readManifest()
  const record = await store.readContractRecord()
  const contract = record?.contract ?? null
  const seal = await store.readContractSeal()

  if (!manifest) problems.push('尚未建立源基线：请先运行 curation_init')
  if (!contract) {
    problems.push('尚未冻结口径契约：请先运行 curation_contract')
  } else if (!seal) {
    problems.push('契约缺少封印（contract.sha256）：请重新签署 curation_contract')
  } else {
    const actual = contractHash(contract)
    if (seal !== actual) problems.push('契约封印与工作区存储不一致：契约被手工改动，请重新签署 curation_contract')
    if (record.hash !== actual) problems.push('工作区中的契约哈希与内容不一致：请重新签署 curation_contract')
    if (contract.version !== CONTRACT_VERSION) {
      problems.push(`契约版本过旧（v${contract.version}，当前 v${CONTRACT_VERSION}）：请重新签署 curation_contract`)
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
  const sourceProblem = contract ? checkRecordSource(store, contract) : null
  if (sourceProblem) problems.push(sourceProblem)
  return { manifest, contract, record, manifestCheck, problems }
}

/** The read-only record source must never be the workspace database itself. */
function checkRecordSource(store, contract) {
  if (contract?.records?.kind !== 'db') return null
  try {
    if (resolveInside(store.cwd, contract.records.db) === store.dbPath) {
      return '记录源不能是工作区数据库本身：只读源与可写工作区必须分开'
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

export async function doInit(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'init', () => doInitLocked(store, args))
}

async function doInitLocked(store, { cwd, stateDir, sources, force = false }) {
  if (!Array.isArray(sources) || sources.length === 0) return { ok: false, error: 'sources 必须是非空数组' }
  const existing = await store.readManifest()
  if (existing && !force) {
    return { ok: false, error: '源基线已存在。确需重建基线请传 force:true（旧基线与已裁定结果将不可信）' }
  }
  const exclude = [toPosix(relative(cwd, store.dir))]
  const warnings = []
  for (const src of sources) {
    const abs = resolveInside(cwd, src)
    // The source may be the workspace itself, or a parent directory of it
    // (`sources: ['.']` is the common case) — either way the baseline must not
    // contain the workspace, or every workspace write would look like drift.
    if (abs === store.dir || abs.startsWith(`${store.dir}/`) || store.dir.startsWith(`${abs}/`)) {
      warnings.push(`sources 包含工作区目录 ${exclude[0]}，已从基线排除`)
    }
  }
  const manifest = await buildManifest(cwd, sources, { exclude })
  await store.writeManifest(manifest)
  await store.withDb(() => {}) // create the workspace with its schema
  return {
    ok: true,
    files: manifest.entries.length,
    sha256: manifest.sha256,
    sources: manifest.sources,
    excluded: exclude,
    warnings,
    stateDir: store.dir,
    workspace: store.dbPath,
  }
}

export async function doContract(args) {
  const store = storeFor(args.cwd, args.stateDir)
  // Dry runs only validate: they read the workspace but never write it.
  if (args.dryRun) return doContractLocked(store, args)
  return locked(store, 'contract', () => doContractLocked(store, args))
}

async function doContractLocked(store, { cwd, stateDir, contract, force = false, dryRun = false }) {
  const check = validateContract(contract)
  if (!check.ok) return { ok: false, error: '契约校验失败', errors: check.errors }
  const sourceProblem = checkRecordSource(store, check.contract)
  if (sourceProblem) return { ok: false, error: sourceProblem }

  const warnings = []
  let recordCount = null
  try {
    recordCount = (await resolveRecordIds(cwd, check.contract)).length
  } catch (e) {
    warnings.push(`记录集暂时无法解析：${e.message}`)
  }
  const hash = contractHash(check.contract)
  const summary = {
    hash,
    fields: fieldNames(check.contract),
    channels: check.contract.channels.map((c) => c.name),
    records: recordCount,
    delivery: check.contract.delivery,
    warnings,
  }

  if (dryRun) return { ok: true, dryRun: true, ...summary, contract: check.contract }

  if (!(await store.readManifest())) return { ok: false, error: '尚未建立源基线：请先运行 curation_init' }
  if ((await store.readContractRecord()) && !force) {
    return { ok: false, error: '契约已冻结。确需重签请传 force:true（已裁定结果需全部重新裁定）' }
  }
  await store.writeContract(check.contract)
  return { ok: true, ...summary, stateDir: store.dir, workspace: store.dbPath }
}

export async function doSubmit(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'submit', () => doSubmitLocked(store, args))
}

async function doSubmitLocked(store, { cwd, stateDir, channel, batch, records, meta }) {
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const { contract } = gates
  if (!batch) return { ok: false, error: 'batch 必填（批次号，例如 B001）' }
  if (!contract.channels.some((c) => c.name === channel)) {
    return { ok: false, error: `未声明的通道：${channel}（契约通道：${contract.channels.map((c) => c.name).join(', ')}）` }
  }
  if (!Array.isArray(records) || records.length === 0) return { ok: false, error: 'records 必须是非空数组' }

  const known = new Set(fieldNames(contract))
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
  const count = await store.insertSubmissions({ channel, batch, records: clean, notes: meta?.notes ?? null })
  return { ok: true, channel, batch, records: count, storedIn: store.dbPath }
}

/** Compare every cell across channels and record one decision per cell. */
export async function doCompare(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'compare', () => doCompareLocked(store, args))
}

async function doCompareLocked(store, { cwd, stateDir, records, fields, scope = 'auto' }) {
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const { contract } = gates

  const allRecordIds = await resolveRecordIds(cwd, contract)
  let recordIds = allRecordIds
  if (Array.isArray(records) && records.length) {
    const known = new Set(allRecordIds)
    const unknown = records.filter((r) => !known.has(String(r)))
    if (unknown.length) return { ok: false, error: `记录不在契约记录集中：${unknown.slice(0, 10).join(', ')}` }
    recordIds = records.map(String)
  }
  if (Array.isArray(fields) && fields.length) {
    const known = new Set(fieldNames(contract))
    const unknown = fields.filter((f) => !known.has(f))
    if (unknown.length) return { ok: false, error: `契约中没有这些字段：${unknown.join(', ')}` }
  }
  if (scope !== 'auto' && scope !== 'all') {
    return { ok: false, error: `scope 只能是 auto 或 all：${scope}` }
  }

  const flat = await store.latestSubmissions()
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

  // Incremental mode: only re-decide cells whose newest submission is newer
  // than their newest decision. A contract change invalidates every decision,
  // so auto falls back to a full pass in that case.
  const hash = contractHash(contract)
  const chosenFields = fields?.length ? fields : fieldNames(contract)
  const lastRun = await store.latestRun('compare')
  const sameContract = lastRun?.summary?.contractHash === hash
  let cells = null
  let skippedCells = 0
  if (scope === 'all' || !sameContract) {
    // full pass
  } else {
    const stale = await store.staleCells({ records: recordIds, fields: chosenFields })
    const covered = new Set(recordIds)
    cells = stale.filter((c) => covered.has(c.record))
    skippedCells = recordIds.length * chosenFields.length - cells.length
    if (cells.length === 0) {
      return {
        ok: true,
        skipped: true,
        scope,
        runId: null,
        records: recordIds.length,
        fields: chosenFields.length,
        channels: usedChannels,
        recomputed: 0,
        skippedCells,
        accepted: 0,
        pending: 0,
        synthesized: 0,
        byReason: {},
        workspace: store.dbPath,
      }
    }
  }

  const decisions = adjudicate({ contract, recordIds, fields, submissionsByRecord: byRecord, root: store.cwd, cells })
  const runId = newRunId()
  const stats = summarize(decisions)
  const pendingItems = decisions
    .filter((d) => d.status !== 'accepted')
    .map((d) => ({
      record: d.record,
      field: d.field,
      reason: d.reason,
      votes: (d.votes ?? []).map((v) => ({ channel: v.channel, valid: v.valid, present: v.present, raw: v.raw })),
    }))

  // Decisions and the run summary land in one transaction: a compare either
  // happens completely or not at all, and no decision row can reference a run
  // that was never recorded. The pending mirror is derived, written after.
  await store.withDb((db) => withTransaction(db, () => {
    insertDecisionsTx(db, runId, decisions)
    insertRunTx(db, runId, 'compare', {
      runId,
      scope: cells ? 'auto' : 'all',
      recomputed: decisions.length,
      skippedCells,
      contractHash: hash,
      records: recordIds.length,
      fields: chosenFields.length,
      channels: usedChannels,
      accepted: stats.accepted,
      pending: stats.pending,
      synthesized: stats.synthesized,
      byReason: stats.byReason,
    })
  }))
  await store.writePending(runId, pendingItems)
  return {
    ok: true,
    runId,
    scope: cells ? 'auto' : 'all',
    records: recordIds.length,
    fields: chosenFields.length,
    channels: usedChannels,
    recomputed: decisions.length,
    skippedCells,
    ...stats,
    workspace: store.dbPath,
  }
}

export async function doApply(args) {
  const store = storeFor(args.cwd, args.stateDir)
  return locked(store, 'apply', () => doApplyLocked(store, args))
}

async function doApplyLocked(store, { cwd, stateDir, dryRun = false }) {
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const { contract } = gates
  const delivery = contract.delivery
  const fields = contract.fields

  const latest = await store.latestDecisions()
  if (!latest.length) return { ok: false, error: '没有比对记录：请先运行 curation_compare' }
  const accepted = latest.filter((d) => d.status === 'accepted')
  if (!accepted.length) return { ok: false, error: '没有任何被两个通道一致确认的格子，未写入' }

  const ops = accepted.map((d) => ({
    record: String(d.record),
    field: d.field,
    value: d.value === null || d.value === undefined ? '' : String(d.value),
  }))

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
      // A backup is a consistent snapshot and cannot run inside a transaction,
      // so it happens first: if the write below fails, the backup is simply
      // unused, never a snapshot of a half-written table.
      if (!dryRun) backup = backupDb(db, backupPath)
      if (dryRun) {
        return { result: applyCuration({ db, delivery, fields, ops, dryRun: true }), before }
      }
      // cells + ledger + applied in ONE transaction: there is no committed
      // state in which the table changed without its own audit trail.
      const result = withTransaction(db, () => {
        const written = applyCurationInTx({ db, delivery, fields, ops })
        insertLedgerTx(db, accepted.map((d) => {
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
          }
        }))
        writeAppliedTx(db, {
          runId: applyRunId,
          appliedAt,
          ops: ops.length,
          backup,
          deliveryTable: delivery.table,
        })
        return written
      })
      return { result, before }
    })
  } catch (e) {
    if (e?.code === WRITE_FAILED) return { ok: false, error: '写入失败', errors: e.errors }
    // A trigger, a lock collision or a corrupted page: the transaction is
    // already rolled back, so report it instead of leaking a driver error.
    if (e?.errcode !== undefined || String(e?.code ?? '').startsWith('ERR_SQLITE')) {
      return { ok: false, error: '写入失败', errors: [String(e.message ?? e)] }
    }
    throw e
  }
  if (!outcome.result.ok) return { ok: false, error: '写入失败', errors: outcome.result.errors }
  return {
    ok: true,
    dryRun,
    applied: outcome.result.applied,
    backup,
    delivery: delivery.table,
    workspace: store.dbPath,
    created: outcome.result.created ?? false,
    addedColumns: outcome.result.addedColumns ?? [],
    warnings: outcome.result.warnings ?? [],
    sample: ops.slice(0, 5),
  }
}

/** Export the curated table through a registered or project-defined exporter. */
export async function doExport({ cwd, stateDir, format = 'csv', out = null }) {
  const store = storeFor(cwd, stateDir)
  const gates = await requireGates(store)
  if (!gates.ok) return gates
  const delivery = gates.contract.delivery
  const table = await store.withDb((db) => readCuratedSafe(db, delivery))
  if (!table) return { ok: false, error: `交付表尚未生成：${delivery.table}（先运行 curation_apply）` }

  const external = Object.fromEntries((await store.listExporters())
    .map((e) => [e.name, { command: e.command, args: e.args }]))
  let exporter
  try {
    exporter = resolveExporter(format, external)
  } catch (e) {
    return { ok: false, error: e.message }
  }
  let target
  if (out) {
    target = resolveInside(cwd, out)
  } else {
    const dir = join(store.dir, 'exports')
    await ensureDir(dir)
    const stamp = nowIso().replace(/[:.]/g, '-')
    target = join(dir, `${delivery.table}-${stamp}.${exporter.extension}`)
  }
  const result = await runExporter(format, {
    contract: gates.contract,
    external,
    cwd,
    table: delivery.table,
    key: delivery.key,
    columns: table.header,
    rows: table.rows,
    fields: gates.contract.fields,
    out: target,
  })
  return {
    ok: true,
    format,
    kind: result.kind ?? exporter.kind,
    path: toPosix(target),
    rows: result.rows ?? table.rows.length,
    columns: result.columns ?? table.header.length,
    workspace: store.dbPath,
  }
}

/** List, add or remove project-level exporters (stored in the workspace). */
export async function doExporter(args) {
  const store = storeFor(args.cwd, args.stateDir)
  const op = args.action === 'list' ? null : 'exporter'
  if (!op) return doExporterLocked(store, args)
  return locked(store, op, () => doExporterLocked(store, args))
}

async function doExporterLocked(store, { cwd, stateDir, action = 'list', name, command, args = [] }) {
  if (action === 'list') {
    return {
      ok: true,
      builtins: listExporters(),
      project: await store.listExporters(),
      workspace: store.dbPath,
    }
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

/** Package the project (workspace snapshot + contract + referenced scripts). */
export async function doPack(args) {
  const store = storeFor(args.cwd, args.stateDir)
  // Packing snapshots the workspace; it must not race a write.
  return locked(store, 'pack', () => doPackLocked(store, args), { ttlMs: 20 * 60 * 1000 })
}

async function doPackLocked(store, { cwd, stateDir, out = null, label = null }) {
  const target = out ? resolveInside(cwd, out) : null
  return buildPack(store, { out: target, label })
}

function runVerifyCmd(cwd, cmd) {
  if (!cmd) return null
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 8 << 20 })
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

export async function doVerify(args) {
  const store = storeFor(args.cwd, args.stateDir)
  // verify may run a user command for up to 15 minutes; give the lease room.
  return locked(store, 'verify', () => doVerifyLocked(store, args), { ttlMs: 25 * 60 * 1000 })
}

async function doVerifyLocked(store, { cwd, stateDir }) {
  const gates = await loadGates(store, { full: true })
  const checks = []
  const add = (name, ok, detail, severity = 'fail') => checks.push({ name, status: ok ? 'pass' : severity, detail })

  add('state_present', Boolean(gates.manifest && gates.contract), gates.manifest && gates.contract ? '基线与契约存在' : '缺少基线或契约')
  const seal = await store.readContractSeal()
  add('contract_intact', Boolean(gates.contract) && Boolean(seal) && seal === contractHash(gates.contract), '契约封印与工作区存储一致')
  add('manifest_intact', Boolean(gates.manifestCheck?.ok), gates.manifestCheck
    ? `检查 ${gates.manifestCheck.checked} 个源文件：变化 ${gates.manifestCheck.changed.length}，缺失 ${gates.manifestCheck.missing.length}，新增 ${gates.manifestCheck.added.length}`
    : '无基线')
  if (!gates.contract) {
    return { ok: false, status: 'FAIL', checks, problems: gates.problems }
  }

  const contract = gates.contract
  const delivery = contract.delivery
  const fields = fieldNames(contract)
  const recordIds = []
  try {
    const ids = await resolveRecordIds(cwd, contract)
    recordIds.push(...ids)
    add('records_resolvable', ids.length > 0, `记录 ${ids.length} 条`)
  } catch (e) {
    add('records_resolvable', false, e.message)
  }

  const latest = await store.latestDecisions()
  const cellKey = (record, field) => `${record}\u0000${field}`
  const byCell = new Map(latest.map((d) => [cellKey(d.record, d.field), d]))
  const accepted = latest.filter((d) => d.status === 'accepted')
  const pending = latest.filter((d) => d.status !== 'accepted')
  const total = recordIds.length * fields.length

  const missingCells = []
  for (const record of recordIds) for (const field of fields) if (!byCell.has(cellKey(record, field))) missingCells.push(`${record}.${field}`)
  add('coverage', missingCells.length === 0, missingCells.length
    ? `未处理 ${missingCells.length}/${total} 格，例如 ${missingCells.slice(0, 5).join(', ')}`
    : `${total}/${total} 格都有比对记录`)

  const weak = accepted.filter((d) => !Array.isArray(d.adopted) || d.adopted.length < 2)
  add('accepted_two_channels', weak.length === 0, weak.length ? `${weak.length} 格接受结果不足两个一致通道` : '所有接受结果均有两个一致通道')

  const noEvidence = accepted.filter((d) => {
    if (d.normalized === '') return false
    return !(d.evidence ?? []).some((e) => e.page !== null || e.quote)
  })
  add('evidence_present', noEvidence.length === 0, noEvidence.length ? `${noEvidence.length} 格缺少页码或原文证据` : '接受格均有证据')

  let curated = null
  try {
    curated = await store.withDb((db) => readCuratedSafe(db, delivery))
  } catch (e) {
    add('delivery_matches', false, e.message)
  }
  if (curated) {
    const byKey = new Map(curated.rows.map((r) => [String(r[delivery.key]), r]))
    const fieldByName = new Map(contract.fields.map((f) => [f.name, f]))
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

  const ledger = await store.latestLedger()
  const ledgerKeys = new Set(ledger.map((r) => `${r.record}\u0000${r.field}\u0000${r.new_value ?? ''}`))
  const noLedger = accepted.filter((d) => !ledgerKeys.has(`${d.record}\u0000${d.field}\u0000${String(d.value ?? '')}`))
  add('ledger_complete', noLedger.length === 0, noLedger.length ? `${noLedger.length} 个接受格没有落表留痕` : `留痕 ${ledger.length} 行`)

  const ratio = total ? accepted.length / total : 0
  const minRatio = contract.gates?.minAcceptedRatio ?? 0
  add('accept_ratio', ratio >= minRatio, `接受比例 ${(ratio * 100).toFixed(2)}% / 门槛 ${(minRatio * 100).toFixed(0)}%`)

  if (pending.length) {
    add('pending_cells', false, `${pending.length} 格待裁定（未自动改表，不计为已核实）`, 'conditional')
  } else {
    add('pending_cells', true, '无待裁定格')
  }

  const verifyCmd = runVerifyCmd(cwd, contract.gates?.verifyCmd)
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
    ok: status === 'PASS',
    status,
    checks,
    accepted: accepted.length,
    pending: pending.length,
    pendingByReason,
    total,
    verifyCmd,
    problems: gates.problems,
  }
}

export async function doStatus({ cwd, stateDir }) {
  const store = storeFor(cwd, stateDir)
  const manifest = await store.readManifest()
  const record = await store.readContractRecord()
  const contract = record?.contract ?? null
  const channelStats = await store.channelStats()
  const latest = await store.latestDecisions()
  const accepted = latest.filter((d) => d.status === 'accepted')
  const pending = latest.filter((d) => d.status !== 'accepted')
  const reasons = {}
  for (const d of pending) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
  const synthesized = accepted.filter((d) => d.synthesized).length
  const runs = await store.runStats()
  let delivery = null
  if (contract) {
    const curated = await store.withDb((db) => readCuratedSafe(db, contract.delivery))
    delivery = {
      table: contract.delivery.table,
      key: contract.delivery.key,
      rows: curated ? curated.rows.length : null,
      columns: curated ? curated.header.length : null,
    }
  }
  return {
    ok: Boolean(manifest && contract),
    stateDir: store.dir,
    workspace: store.dbPath,
    manifest: manifest ? { files: manifest.entries.length, sha256: manifest.sha256, createdAt: manifest.createdAt, sources: manifest.sources } : null,
    contract: contract
      ? {
          version: contract.version,
          hash: record.hash,
          fields: contract.fields.length,
          channels: contract.channels.map((c) => c.name),
          delivery: contract.delivery,
          records: contract.records,
          adjudication: contract.adjudication ?? null,
          minAcceptedRatio: contract.gates?.minAcceptedRatio ?? 0,
          verifyCmd: contract.gates?.verifyCmd ?? null,
        }
      : null,
    exporters: { builtins: listExporters(), project: await store.listExporters() },
    channels: channelStats,
    runs,
    decisions: { total: latest.length, accepted: accepted.length, pending: pending.length, synthesized, byReason: reasons },
    delivery,
    applied: await store.readApplied(),
    pendingFile: store.pendingPath,
    lock: await readLock(store),
  }
}

/** Compact plan of what a next compare would cover (no writes). */
export async function coveragePreview(cwd, stateDir) {
  const store = storeFor(cwd, stateDir)
  const contract = await store.readContract()
  if (!contract) return null
  const recordIds = await resolveRecordIds(cwd, contract)
  return {
    records: recordIds.length,
    fields: fieldNames(contract).length,
    cells: recordIds.length * fieldNames(contract).length,
    channels: contract.channels.map((c) => c.name),
    delivery: contract.delivery,
    contractHash: await store.readContractSeal(),
  }
}
