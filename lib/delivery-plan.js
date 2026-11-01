// lib/delivery-plan.js — a delivery package (curated tables + pending list +
// review + manifest) that does not depend on single-table export semantics.
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import { createStore } from './store.js'
import { doExport, doQuery } from './core.js'
import { atomicWrite, csvParse, ensureDir, nowIso, resolveInside, toPosix } from './util.js'

const PLAN_FILE = 'delivery-plan.json'
const planPath = (store) => join(store.dir, PLAN_FILE)

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

async function activeTables(store) {
  const pin = await store.readPin()
  return (pin?.tables ?? []).filter((t) => (t.status ?? 'active') === 'active').map((t) => t.table)
}

async function defaultPlan(store) {
  const tables = await activeTables(store)
  return {
    version: 1,
    name: 'delivery',
    tables: tables.map((table) => ({ table, format: 'jsonl' })),
    pending: { file: 'pending.csv' },
    review: { file: 'review.md' },
  }
}

function packageFile(root, value, label) {
  try {
    const abs = resolveInside(root, String(value))
    const rel = relative(root, abs)
    if (!rel) return { ok: false, error: `${label} 必须是交付目录内的文件路径` }
    return { ok: true, file: toPosix(rel) }
  } catch {
    return { ok: false, error: `${label} 必须留在交付目录内：${value}` }
  }
}

async function normalizePlan(store, input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'plan 必须是对象' }
  const known = new Set(await activeTables(store))
  if (!Array.isArray(input.tables) || !input.tables.length) return { ok: false, error: 'plan.tables 必须是非空数组' }
  const tables = []
  for (const item of input.tables) {
    const table = typeof item === 'string' ? item : item?.table
    if (!table || !known.has(table)) return { ok: false, error: `plan.tables 含未登记/已退役的表：${table}` }
    const format = (typeof item === 'object' && item.format) || 'jsonl'
    if (!['csv', 'jsonl'].includes(format)) return { ok: false, error: `plan.tables 含不支持的格式：${format}（csv/jsonl）` }
    tables.push({ table, format })
  }
  const name = String(input.name || 'delivery')
  try {
    resolveInside(join(store.dir, 'deliveries'), `${name}-package`)
  } catch {
    return { ok: false, error: `plan.name 必须留在交付目录内：${name}` }
  }
  const packageRoot = join(store.dir, 'deliveries', 'package')
  const pending = packageFile(packageRoot, String(input.pending?.file || 'pending.csv'), 'plan.pending.file')
  if (!pending.ok) return pending
  const review = packageFile(packageRoot, String(input.review?.file || 'review.md'), 'plan.review.file')
  if (!review.ok) return review
  return {
    ok: true,
    plan: {
      version: 1,
      name,
      tables,
      pending: { file: pending.file },
      review: { file: review.file },
    },
  }
}

export async function doDeliveryPlan({ cwd, stateDir = '.curation', action = 'show', plan = null, out = null } = {}) {
  const store = createStore(cwd, stateDir)
  try {
    if (action === 'show') {
      const text = await fs.readFile(planPath(store), 'utf8').catch(() => null)
      if (!text) return { ok: false, error: '尚未声明交付计划：先运行 action:"write" 或 action:"build"' }
      return { ok: true, planPath: toPosix(relative(cwd, planPath(store))), plan: JSON.parse(text) }
    }
    if (action === 'write') {
      const base = plan ? await normalizePlan(store, plan) : { ok: true, plan: await defaultPlan(store) }
      if (!base.ok) return base
      await atomicWrite(planPath(store), `${JSON.stringify(base.plan, null, 2)}\n`)
      return { ok: true, planPath: toPosix(relative(cwd, planPath(store))), plan: base.plan }
    }
    if (action !== 'build') return { ok: false, error: `未知 action：${action}（show/write/build）` }
    let resolved
    if (plan) {
      resolved = await normalizePlan(store, plan)
      if (!resolved.ok) return resolved
    } else {
      const text = await fs.readFile(planPath(store), 'utf8').catch(() => null)
      if (!text) {
        resolved = { ok: true, plan: await defaultPlan(store) }
        await atomicWrite(planPath(store), `${JSON.stringify(resolved.plan, null, 2)}\n`)
      } else {
        const parsed = JSON.parse(text)
        resolved = await normalizePlan(store, parsed)
        if (!resolved.ok) return resolved
      }
    }
    const deliveryPlan = resolved.plan
    const stamp = nowIso().replace(/[:.]/g, '-')
    const targetAbs = out
      ? resolveInside(cwd, String(out))
      : resolveInside(join(store.dir, 'deliveries'), `${deliveryPlan.name || 'delivery'}-${stamp}`)
    const targetRel = toPosix(relative(cwd, targetAbs))
    await ensureDir(targetAbs)
    const files = []
    const tables = []
    for (const entry of deliveryPlan.tables) {
      const format = entry.format === 'csv' ? 'csv' : 'jsonl'
      const file = resolveInside(join(targetAbs, 'tables'), `${entry.table}.${format}`)
      await ensureDir(join(targetAbs, 'tables'))
      const exported = await doExport({ cwd, stateDir, table: entry.table, format, out: toPosix(relative(cwd, file)) })
      if (!exported.ok) return { ok: false, error: `导出表 ${entry.table} 失败：${exported.error}`, plan: deliveryPlan }
      tables.push({ table: entry.table, format, file: toPosix(relative(targetAbs, file)), rows: exported.rows, columns: exported.columns })
      files.push(toPosix(relative(cwd, file)))
    }
    const pending = await doQuery({ cwd, stateDir, what: 'pending', limit: 1000000 })
    if (!pending.ok) return pending
    const pendingFile = resolveInside(targetAbs, deliveryPlan.pending.file)
    const lines = ['table,record,field,reason']
    for (const row of pending.data) lines.push([row.table, row.record, row.field, row.reason].map(csvCell).join(','))
    await atomicWrite(pendingFile, `${lines.join('\n')}\n`)
    files.push(toPosix(relative(cwd, pendingFile)))

    const counts = await doQuery({ cwd, stateDir, what: 'counts' })
    const reviewFile = resolveInside(targetAbs, deliveryPlan.review.file)
    const review = [
      `# ${deliveryPlan.name} 复核摘要`,
      '',
      `生成时间：${nowIso()}`,
      '',
      ...(counts.ok && counts.data.tables?.length
        ? counts.data.tables.map((t) => `- 表 ${t.table}：${t.status}，修订 ${t.revision ?? '—'}`)
        : ['- 无表信息']),
      '',
      counts.ok ? `结论：接受 ${counts.data.decisions.accepted} / 待裁定 ${counts.data.decisions.pending}` : '结论：不可用',
      '',
      '待裁定不计为已核实；发布前请按 pin 门禁运行 curation_verify。',
      '',
    ].join('\n')
    await atomicWrite(reviewFile, review)
    files.push(toPosix(relative(cwd, reviewFile)))

    const manifest = {
      version: 1,
      generatedAt: nowIso(),
      pinHash: (await fs.readFile(store.sealPath, 'utf8')).trim(),
      project: (await store.readProject())?.name ?? null,
      plan: deliveryPlan,
      tables,
      pending: { file: toPosix(relative(targetAbs, pendingFile)), count: pending.data.length },
      review: { file: toPosix(relative(targetAbs, reviewFile)) },
    }
    const manifestFile = join(targetAbs, 'delivery.json')
    await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    files.push(toPosix(relative(cwd, manifestFile)))
    return { ok: true, path: targetRel, files, manifest }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function doVerifyDelivery({ cwd, stateDir = '.curation', path = null } = {}) {
  const store = createStore(cwd, stateDir)
  try {
    let dir
    if (path) dir = resolveInside(cwd, String(path))
    else {
      const base = join(store.dir, 'deliveries')
      const entries = (await fs.readdir(base).catch(() => [])).sort()
      if (!entries.length) return { ok: false, status: 'FAIL', checks: [{ name: 'delivery_present', status: 'fail', detail: '没有交付包' }] }
      dir = join(base, entries.at(-1))
    }
    const checks = []
    const add = (name, ok, detail) => checks.push({ name, status: ok ? 'pass' : 'fail', detail })
    const manifestPath = join(dir, 'delivery.json')
    let manifest = null
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) } catch { /* handled below */ }
    add('delivery_present', Boolean(manifest), manifest ? '交付清单存在' : `缺少 ${toPosix(relative(cwd, manifestPath))}`)
    if (!manifest) return { ok: false, status: 'FAIL', path: toPosix(relative(cwd, dir)), checks }
    const seal = await fs.readFile(store.sealPath, 'utf8').catch(() => '')
    add('pin_intact', Boolean(seal) && manifest.pinHash === seal.trim(), manifest.pinHash === seal.trim() ? '与当前 pin 封印一致' : '交付包不是当前 pin 生成的')
    for (const t of manifest.tables ?? []) {
      const abs = resolveInside(dir, String(t.file ?? ''))
      const text = await fs.readFile(abs, 'utf8').catch(() => null)
      const rows = text === null
        ? -1
        : t.format === 'csv'
          ? Math.max(0, csvParse(text).length - 1)
          : text.split('\n').filter((l) => l.trim()).length
      add(`table:${t.table}`, rows === t.rows, rows === t.rows ? `${t.table} ${rows} 行` : `${t.table} 行数 ${rows}，清单 ${t.rows}`)
    }
    const pendingAbs = resolveInside(dir, String(manifest.pending?.file ?? ''))
    const pendingText = await fs.readFile(pendingAbs, 'utf8').catch(() => null)
    const pendingRows = pendingText === null ? -1 : Math.max(0, csvParse(pendingText).length - 1)
    add('pending_present', pendingRows === (manifest.pending?.count ?? -1), pendingRows === (manifest.pending?.count ?? -1) ? `待裁定 ${pendingRows} 行` : `待裁定行数 ${pendingRows}，清单 ${manifest.pending?.count}`)
    const review = await fs.readFile(resolveInside(dir, String(manifest.review?.file ?? '')), 'utf8').catch(() => null)
    add('review_present', Boolean(review), review ? '复核摘要存在' : '缺少复核摘要')
    const status = checks.every((c) => c.status === 'pass') ? 'PASS' : 'FAIL'
    return { ok: status === 'PASS', status, path: toPosix(relative(cwd, dir)), checks }
  } catch (e) {
    return { ok: false, status: 'FAIL', error: e.message, checks: [] }
  }
}
