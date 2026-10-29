import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  doApply, doCompare, doContract, doExport, doInit, doStatus, doSubmit, doVerify,
} from '../lib/core.js'

const WORKSPACE = '.curation/project.sqlite'

async function makeProject(records = ['CASE-0001']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 位于A区，大小约 1.5cm\n', 'utf8')
  return root
}

/** Read the curated table straight from the workspace (null when not created yet). */
function readCurated(root, table = 'summary') {
  const db = new DatabaseSync(join(root, WORKSPACE))
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
    if (!exists) return null
    return db.prepare(`SELECT * FROM ${table} ORDER BY record_id`).all().map((r) => ({ ...r }))
  } finally {
    db.close()
  }
}

function mutateCurated(root, sql, ...params) {
  const db = new DatabaseSync(join(root, WORKSPACE))
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

const contractOf = (records = ['CASE-0001']) => ({
  fields: [
    { name: 'location', allowEmpty: false },
    { name: 'measured_value', type: 'number', allowEmpty: true },
    { name: 'note', allowEmpty: true, requireEvidence: false },
  ],
  records: { kind: 'list', values: records },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  gates: { minAcceptedRatio: 1 },
})

async function twoChannelRun(root, records = ['CASE-0001']) {
  assert.equal((await doContract({ cwd: root, contract: contractOf(records) })).ok, true)
  for (const record of records) {
    const text = await doSubmit({
      cwd: root,
      channel: 'text',
      batch: 'B001',
      records: [{ record_id: record, status: 'valid', values: { location: 'A区', measured_value: '1.5cm', note: '' }, evidence: { location: { page: 1 }, measured_value: { page: 1 } } }],
    })
    assert.equal(text.ok, true, text.error)
    const vision = await doSubmit({
      cwd: root,
      channel: 'vision',
      batch: 'B001',
      records: [{ record_id: record, status: 'valid', values: { location: 'A区', measured_value: '15mm', note: '' }, evidence: { location: { page: 1 }, measured_value: { page: 1 } } }],
    })
    assert.equal(vision.ok, true, vision.error)
  }
}

test('端到端：基线 → 契约 → 双通道 → 比对 → 落表 → 验收 PASS', async () => {
  const root = await makeProject()
  const init = await doInit({ cwd: root, sources: ['raw'] })
  assert.equal(init.ok, true)
  assert.equal(init.files, 1)
  assert.ok(init.workspace.endsWith(WORKSPACE))
  await twoChannelRun(root)

  const cmp = await doCompare({ cwd: root })
  assert.equal(cmp.ok, true)
  assert.equal(cmp.accepted, 3)
  assert.equal(cmp.pending, 0)

  const dry = await doApply({ cwd: root, dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.applied, 3)
  assert.equal(readCurated(root), null) // 演练不建表

  const applied = await doApply({ cwd: root })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.equal(applied.created, true)
  assert.ok(applied.backup && applied.backup.includes('project.sqlite'))
  const row = readCurated(root)[0]
  assert.equal(row.location, 'A区')
  assert.equal(row.measured_value, '1.5cm') // 原文写法，归一化只用于比较
  assert.equal(row.note, null)

  const verified = await doVerify({ cwd: root })
  assert.equal(verified.status, 'PASS', JSON.stringify(verified.checks))
  const names = verified.checks.map((c) => c.name)
  assert.ok(names.includes('ledger_complete'))
  assert.ok(names.includes('decision_runs_recorded'))
})

test('契约 dryRun 只校验，不冻结；未冻结时比对被阻断', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  const dry = await doContract({ cwd: root, contract: contractOf(), dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.equal(dry.delivery.table, 'summary')

  const blocked = await doCompare({ cwd: root })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /尚未冻结口径契约/)
})

test('导出：未落表报错，落表后 CSV/JSONL 是可重建派生物', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root)
  await doCompare({ cwd: root })

  const tooEarly = await doExport({ cwd: root, format: 'csv' })
  assert.equal(tooEarly.ok, false)
  assert.match(tooEarly.error, /尚未生成/)

  await doApply({ cwd: root })

  const csv = await doExport({ cwd: root, format: 'csv' })
  assert.equal(csv.ok, true, csv.error)
  assert.equal(csv.rows, 1)
  const text = await readFile(csv.path, 'utf8')
  assert.match(text, /record_id,location,measured_value,note/)
  assert.match(text, /CASE-0001,A区,/)

  const jsonl = await doExport({ cwd: root, format: 'jsonl' })
  assert.equal(jsonl.ok, true, jsonl.error)
  const line = (await readFile(jsonl.path, 'utf8')).trim()
  assert.equal(JSON.parse(line).record_id, 'CASE-0001')

  const unknown = await doExport({ cwd: root, format: 'parquet' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /未注册的导出格式/)
})

test('源文件被改一个字节：验收 FAIL 且写入被阻断', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root)
  await doCompare({ cwd: root })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 位于A区，大小约 1.5cmX\n', 'utf8')

  const verified = await doVerify({ cwd: root })
  assert.equal(verified.status, 'FAIL')
  const manifest = verified.checks.find((c) => c.name === 'manifest_intact')
  assert.equal(manifest.status, 'fail')

  const blocked = await doApply({ cwd: root })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /源基线漂移/)
})

test('curated 表被手工改过：验收判 delivery_matches 失败', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root)
  await doCompare({ cwd: root })
  assert.equal((await doApply({ cwd: root })).ok, true)

  mutateCurated(root, "UPDATE summary SET measured_value = '99mm' WHERE record_id = ?", 'CASE-0001')
  const verified = await doVerify({ cwd: root })
  assert.equal(verified.status, 'FAIL')
  assert.equal(verified.checks.find((c) => c.name === 'delivery_matches').status, 'fail')
})

test('契约封印缺失：验收判 contract_intact 失败', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root)
  await rm(join(root, '.curation', 'contract.sha256'))
  const verified = await doVerify({ cwd: root })
  assert.equal(verified.status, 'FAIL')
  assert.equal(verified.checks.find((c) => c.name === 'contract_intact').status, 'fail')
})

test('只有一个通道有提交时拒绝比对', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await doContract({ cwd: root, contract: contractOf() })
  await doSubmit({
    cwd: root, channel: 'text', batch: 'B001',
    records: [{ record_id: 'CASE-0001', status: 'valid', values: { location: 'A区' } }],
  })
  const cmp = await doCompare({ cwd: root })
  assert.equal(cmp.ok, false)
  assert.match(cmp.error, /至少需要两个独立通道/)
})

test('提交未声明字段整批拒绝', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await doContract({ cwd: root, contract: contractOf() })
  const bad = await doSubmit({
    cwd: root, channel: 'text', batch: 'B001',
    records: [{ record_id: 'CASE-0001', status: 'valid', values: { locaton: 'A区' } }],
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /未声明的字段/)
})

test('同一通道同一批次重提会替换旧值而不是累加', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await doContract({ cwd: root, contract: contractOf() })
  await doSubmit({
    cwd: root, channel: 'text', batch: 'B001',
    records: [{ record_id: 'CASE-0001', status: 'valid', values: { location: 'B区' }, evidence: { location: { page: 1 } } }],
  })
  await doSubmit({
    cwd: root, channel: 'text', batch: 'B001',
    records: [{ record_id: 'CASE-0001', status: 'valid', values: { location: 'A区' }, evidence: { location: { page: 1 } } }],
  })
  await doSubmit({
    cwd: root, channel: 'vision', batch: 'B001',
    records: [{ record_id: 'CASE-0001', status: 'valid', values: { location: 'A区' }, evidence: { location: { page: 1 } } }],
  })
  const cmp = await doCompare({ cwd: root })
  assert.equal(cmp.ok, true, cmp.error)
  const status = await doStatus({ cwd: root })
  // 重提替换而非累加：text 通道只剩一份提交，最终取到的是第二次的 A区
  assert.equal(status.channels.find((c) => c.channel === 'text').submissions, 1)
  assert.equal(status.decisions.accepted, 1)
  assert.equal(status.decisions.byReason.no_valid_channel, 2)
})

test('新增记录在落表时自动建行，重复落表是幂等的', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root, ['CASE-0001', 'CASE-0002'])
  await doCompare({ cwd: root })
  const first = await doApply({ cwd: root })
  assert.equal(first.ok, true, JSON.stringify(first.errors))
  let rows = readCurated(root)
  assert.deepEqual(rows.map((r) => r.record_id), ['CASE-0001', 'CASE-0002'])

  const second = await doApply({ cwd: root })
  assert.equal(second.ok, true, JSON.stringify(second.errors))
  assert.equal(second.created, false)
  rows = readCurated(root)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].location, 'A区')
})

test('待裁定格保持空白，不计为已核实', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  // 未决格存在的场景下不设接受率下限：接受率门槛另有用例覆盖
  await doContract({ cwd: root, contract: { ...contractOf(), gates: { minAcceptedRatio: 0 } } })
  await doSubmit({
    cwd: root, channel: 'text', batch: 'B001',
    records: [{
      record_id: 'CASE-0001', status: 'valid',
      values: { location: 'A区', measured_value: '1.5cm', note: '' },
      evidence: { location: { page: 1 }, measured_value: { page: 1 } },
    }],
  })
  await doSubmit({
    cwd: root, channel: 'vision', batch: 'B001',
    records: [{
      record_id: 'CASE-0001', status: 'valid',
      values: { location: 'A区', measured_value: '2.0cm', note: '' },
      evidence: { location: { page: 1 }, measured_value: { page: 1 } },
    }],
  })
  const cmp = await doCompare({ cwd: root })
  assert.equal(cmp.accepted, 2)
  assert.equal(cmp.pending, 1)

  const applied = await doApply({ cwd: root })
  assert.equal(applied.ok, true, applied.error)
  assert.equal(readCurated(root)[0].measured_value, null) // 待裁定格保持空白

  const verified = await doVerify({ cwd: root })
  assert.equal(verified.status, 'CONDITIONAL', JSON.stringify(verified.checks))
  assert.equal(verified.checks.find((c) => c.name === 'pending_cells').status, 'conditional')

  const status = await doStatus({ cwd: root })
  assert.equal(status.decisions.pending, 1)
  assert.equal(status.decisions.byReason.no_two_channel_agreement, 1)
})

test('基线重复建立需要 force', async () => {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  const again = await doInit({ cwd: root, sources: ['raw'] })
  assert.equal(again.ok, false)
  assert.match(again.error, /force/)
})
