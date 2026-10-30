// S2: one workspace, several tables. Every run-state row carries table_id, so
// the same record key may exist in two tables without leaking values.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { doApply, doCompare, doExport, doInit, doPin, doQuery, doStatus, doSubmit, doVerify } from '../lib/core.js'

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'curation-multi-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'a.txt'), 'CASE-1\n', 'utf8')
  await writeFile(join(root, 'raw', 'b.txt'), 'CASE-1\n', 'utf8')
  return root
}

const tableOf = (table) => ({
  table,
  key: 'record_id',
  purpose: `表 ${table}`,
  status: 'active',
  records: { kind: 'list', values: ['CASE-1'] },
  fields: [{ name: 'location' }],
})

const pinOf = (tables) => ({
  version: 5,
  project: { name: 'multi', description: null },
  defaults: {
    channels: [{ name: 'text' }, { name: 'vision' }],
    normalization: { mode: 'safe' },
    evidence: { required: false },
    gates: { minAcceptedRatio: 0 },
  },
  tables,
})

const submitBoth = async (root, table, value) => {
  for (const channel of ['text', 'vision']) {
    const r = await doSubmit({ cwd: root, table, channel, batch: 'B1', records: [{ record_id: 'CASE-1', status: 'valid', values: { location: value } }] })
    assert.equal(r.ok, true, r.error)
  }
}

const curatedRows = (root, table) => {
  const db = new DatabaseSync(join(root, '.curation', 'project.sqlite'), { readOnly: true })
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
    if (!exists) return null
    return db.prepare(`SELECT * FROM "${table}" ORDER BY record_id`).all().map((r) => ({ ...r }))
  } finally {
    db.close()
  }
}

test('两张表共用一个记录键：提交、比对、落表、验收互不串数据', async () => {
  const root = await makeProject()
  try {
    const init = await doInit({ cwd: root, sources: ['raw'], tables: ['t1', 't2'] })
    assert.equal(init.ok, true, init.error)

    const pinned = await doPin({ cwd: root, pin: pinOf([tableOf('t1'), tableOf('t2')]) })
    assert.equal(pinned.ok, true, pinned.error)
    assert.deepEqual(pinned.tables.map((t) => t.table).sort(), ['t1', 't2'])

    await submitBoth(root, 't1', '甲区')
    await submitBoth(root, 't2', '乙区')

    const c1 = await doCompare({ cwd: root, table: 't1' })
    assert.equal(c1.ok, true, c1.error)
    assert.equal(c1.accepted, 1)
    const c2 = await doCompare({ cwd: root, table: 't2' })
    assert.equal(c2.ok, true, c2.error)
    assert.equal(c2.accepted, 1)

    const a1 = await doApply({ cwd: root, table: 't1' })
    assert.equal(a1.ok, true, a1.error)
    assert.equal(curatedRows(root, 't1')[0].location, '甲区')
    assert.equal(curatedRows(root, 't2'), null, '落 t1 不应创建 t2')

    const v1 = await doVerify({ cwd: root, table: 't1' })
    assert.equal(v1.status, 'PASS', JSON.stringify(v1.checks?.filter((c) => c.status !== 'pass')))
    const v2 = await doVerify({ cwd: root, table: 't2' })
    assert.equal(v2.status, 'FAIL')
    assert.equal(v2.checks.find((c) => c.name === 'delivery_matches').status, 'fail')

    const projectVerify = await doVerify({ cwd: root })
    assert.equal(projectVerify.status, 'FAIL')
    assert.equal(projectVerify.tables.length, 2)
    assert.equal(projectVerify.tables.find((t) => t.table === 't2').status, 'FAIL')

    const a2 = await doApply({ cwd: root, table: 't2' })
    assert.equal(a2.ok, true, a2.error)
    const both = await doVerify({ cwd: root })
    assert.equal(both.status, 'PASS', JSON.stringify(both.tables.map((t) => [t.table, t.status])))
    assert.equal(curatedRows(root, 't2')[0].location, '乙区')

    const exported = await doExport({ cwd: root, format: 'sqlite' })
    assert.equal(exported.ok, true, exported.error)
    assert.deepEqual(exported.tables.sort(), ['t1', 't2'])
    const snap = new DatabaseSync(exported.path, { readOnly: true })
    try {
      assert.equal(snap.prepare('SELECT location FROM t1').get().location, '甲区')
      assert.equal(snap.prepare('SELECT location FROM t2').get().location, '乙区')
    } finally {
      snap.close()
    }

    const q1 = await doQuery({ cwd: root, what: 'counts', table: 't1' })
    assert.equal(q1.ok, true, q1.error)
    assert.equal(q1.data.decisions.accepted, 1)
    const q2 = await doQuery({ cwd: root, what: 'cells', table: 't2' })
    assert.equal(q2.data.length, 1)
    assert.equal(q2.data[0].table, 't2')

    const status = await doStatus({ cwd: root })
    const t1 = status.tables.find((t) => t.table === 't1')
    const t2 = status.tables.find((t) => t.table === 't2')
    assert.equal(t1.rows, 1)
    assert.equal(t2.rows ?? 0, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('retired 表只读：提交/比对拒绝，数据仍可导出', async () => {
  const root = await makeProject()
  try {
    await doInit({ cwd: root, sources: ['raw'], tables: ['t1', 't2'] })
    await doPin({ cwd: root, pin: pinOf([tableOf('t1'), tableOf('t2')]) })
    await submitBoth(root, 't2', '乙区')
    await doCompare({ cwd: root, table: 't2' })
    await doApply({ cwd: root, table: 't2' })

    const retired = { ...tableOf('t2'), status: 'retired' }
    const re = await doPin({ cwd: root, pin: pinOf([tableOf('t1'), retired]), force: true })
    assert.equal(re.ok, true, re.error)

    const submit = await doSubmit({ cwd: root, table: 't2', channel: 'text', batch: 'B2', records: [{ record_id: 'CASE-1', status: 'valid', values: { location: '丙区' } }] })
    assert.equal(submit.ok, false)
    assert.match(submit.error, /已退役/)

    const cmp = await doCompare({ cwd: root, table: 't2' })
    assert.equal(cmp.ok, false)
    assert.match(cmp.error, /已退役/)

    const exp = await doExport({ cwd: root, table: 't2' })
    assert.equal(exp.ok, true, exp.error)
    assert.equal(exp.table, 't2')

    // retired 表的数据仍然读得到
    assert.equal(curatedRows(root, 't2')[0].location, '乙区')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pin 不得省略已登记的表', async () => {
  const root = await makeProject()
  try {
    await doInit({ cwd: root, sources: ['raw'], tables: ['t1', 't2'] })
    const r = await doPin({ cwd: root, pin: pinOf([tableOf('t1')]) })
    assert.equal(r.ok, false)
    assert.match(r.error, /已登记的表：t2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
