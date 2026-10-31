import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  doApply, doCompare, doInit, doStatus, doSubmit, doVerify,
} from '../lib/core.js'
import { doPinCompat as doPin } from './_pin.js'

const WORKSPACE = '.curation/project.sqlite'

async function makeProject(records = ['CASE-0001']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-apply-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 位于A区，大小约 1.5cm\n', 'utf8')
  return root
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
  assert.equal((await doPin({ cwd: root, contract: contractOf(records) })).ok, true)
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

function workspaceDb(root) {
  return new DatabaseSync(join(root, WORKSPACE))
}

function countRows(root, table) {
  const db = workspaceDb(root)
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
  } finally {
    db.close()
  }
}

function touchCurated(root) {
  const db = workspaceDb(root)
  try {
    db.prepare("UPDATE summary SET note = '手工改动' WHERE record_id = 'CASE-0001'").run()
  } finally {
    db.close()
  }
}

test('compare/apply 返回审计 ID；重复落表是 no-op，不写备份也不写 ledger', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root)

  const cmp = await doCompare({ cwd: root })
  assert.equal(cmp.ok, true)
  assert.ok(cmp.pinId)
  assert.equal(cmp.tablePinRevision, 1)
  assert.match(cmp.pinnedAt, /^\d{4}-\d{2}-\d{2}T/)

  const first = await doApply({ cwd: root })
  assert.equal(first.ok, true)
  assert.equal(first.changed, 3)
  assert.equal(first.unchanged, 0)
  assert.ok(first.applyRunId)
  assert.equal(first.decisionRunId, cmp.runId)
  assert.ok(first.backup)
  assert.equal(countRows(root, 'ledger'), 3)

  const second = await doApply({ cwd: root })
  assert.equal(second.ok, true)
  assert.equal(second.applied, 0)
  assert.equal(second.changed, 0)
  assert.equal(second.unchanged, 3)
  assert.equal(second.backup, null)
  assert.equal(countRows(root, 'ledger'), 3, 'no-op 不应新增 ledger 行')

  assert.equal((await doVerify({ cwd: root })).status, 'PASS')
})

test('只把真实变化的格子写入 ledger：改一格后 changed=1', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root)
  await doCompare({ cwd: root })
  await doApply({ cwd: root })

  touchCurated(root)
  const again = await doApply({ cwd: root })
  assert.equal(again.ok, true)
  assert.equal(again.changed, 1)
  assert.equal(again.unchanged, 2)
  assert.ok(again.backup)
  assert.equal(countRows(root, 'ledger'), 4)
  const db = workspaceDb(root)
  try {
    const row = db.prepare("SELECT changed, old_value, new_value FROM ledger ORDER BY id DESC LIMIT 1").get()
    assert.equal(row.changed, 1)
    assert.equal(row.old_value, '手工改动')
    assert.equal(row.new_value, '')
  } finally {
    db.close()
  }
})

test('pending 分页：默认 100 条 + pendingTotal，full 返回全部', async () => {
  const records = Array.from({ length: 60 }, (_, i) => `R${String(i + 1).padStart(3, '0')}`)
  const root = await makeProject(records)
  await doInit({ cwd: root, sources: ['raw'] })
  assert.equal((await doPin({ cwd: root, contract: contractOf(records) })).ok, true)

  assert.equal((await doSubmit({
    cwd: root, channel: 'text', batch: 'B001',
    records: records.map((record) => ({ record_id: record, status: 'valid', values: { location: 'A区', measured_value: '1.5cm' }, evidence: { location: { page: 1 } } })),
  })).ok, true)
  assert.equal((await doSubmit({
    cwd: root, channel: 'vision', batch: 'B001',
    records: [{ record_id: records[0], status: 'valid', values: { location: 'B区', measured_value: '2cm' }, evidence: { location: { page: 1 } } }],
  })).ok, true)

  const page = await doCompare({ cwd: root })
  assert.equal(page.ok, true)
  assert.equal(page.pending, 180)
  assert.equal(page.pendingTotal, 180)
  assert.equal(page.pendingCells.length, 100)
  assert.equal(page.pendingTruncated, 80)
  assert.equal(page.accepted, 0)

  const full = await doCompare({ cwd: root, full: true, scope: 'all' })
  assert.equal(full.pendingCells.length, 180)
  assert.equal(full.pendingTruncated, 0)
})

test('备份保留：keepBackups 只留最近 N 个，0 表示不清理', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  await twoChannelRun(root)
  await doCompare({ cwd: root })
  const first = await doApply({ cwd: root })
  assert.ok(first.backup)
  const dir = join(root, '.curation', 'backups')
  for (const stamp of ['2020-01-01T00-00-00-000Z', '2020-01-02T00-00-00-000Z', '2020-01-03T00-00-00-000Z']) {
    await writeFile(join(dir, `${stamp}__project.sqlite`), 'old', 'utf8')
  }
  assert.equal((await readdir(dir)).length, 4)

  touchCurated(root)
  const pruned = await doApply({ cwd: root, keepBackups: 2 })
  assert.equal(pruned.ok, true)
  assert.equal((await readdir(dir)).length, 2)

  for (const stamp of ['2020-01-04T00-00-00-000Z', '2020-01-05T00-00-00-000Z']) {
    await writeFile(join(dir, `${stamp}__project.sqlite`), 'old', 'utf8')
  }
  touchCurated(root)
  await doApply({ cwd: root, keepBackups: 0 })
  assert.equal((await readdir(dir)).length, 5, 'keepBackups=0 不清理')
})

test('schema v4 工作区打开时补上 ledger.changed 并升到 v5', async () => {
  const root = await makeProject()
  await doInit({ cwd: root, sources: ['raw'] })
  assert.equal((await doPin({ cwd: root, contract: contractOf() })).ok, true)
  const db = workspaceDb(root)
  try {
    db.exec('ALTER TABLE ledger DROP COLUMN changed')
    db.exec('PRAGMA user_version = 4')
  } finally {
    db.close()
  }

  const status = await doStatus({ cwd: root })
  assert.equal(status.ok, true)
  const upgraded = workspaceDb(root)
  try {
    assert.equal(Number(upgraded.prepare('PRAGMA user_version').get().user_version), 5)
    const columns = upgraded.prepare("SELECT name FROM pragma_table_info('ledger')").all().map((r) => r.name)
    assert.ok(columns.includes('changed'))
  } finally {
    upgraded.close()
  }
})

test.after(async () => {
  // 临时目录留给系统清理；显式删除失败不影响断言结果
  void rm
})
