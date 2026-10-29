import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { doApply, doCompare, doContract, doInit, doSubmit } from '../lib/core.js'

const WORKSPACE = '.curation/project.sqlite'

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-atomic-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 位于A区\n', 'utf8')
  return root
}

const contractOf = () => ({
  fields: [{ name: 'location', allowEmpty: false }],
  records: { kind: 'list', values: ['CASE-0001'] },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  gates: { minAcceptedRatio: 1 },
})

function withDb(root, fn) {
  const db = new DatabaseSync(join(root, WORKSPACE))
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

async function submitBoth(root, value) {
  for (const channel of ['text', 'vision']) {
    const res = await doSubmit({
      cwd: root,
      channel,
      batch: 'B001',
      records: [{
        record_id: 'CASE-0001',
        status: 'valid',
        values: { location: value },
        evidence: { location: { page: 1 } },
      }],
    })
    assert.equal(res.ok, true, res.error)
  }
}

test('落表失败时 curated 表与 ledger 都不留半成品', async () => {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  assert.equal((await doContract({ cwd: root, contract: contractOf() })).ok, true)
  await submitBoth(root, 'A区')
  assert.equal((await doCompare({ cwd: root })).ok, true)

  const first = await doApply({ cwd: root })
  assert.equal(first.ok, true, first.error)
  const ledgerBefore = withDb(root, (db) => db.prepare('SELECT COUNT(*) AS c FROM ledger').get().c)
  assert.equal(ledgerBefore, 1)

  // 让下一次 UPDATE 必然失败：curated 表上加一个 ABORT 触发器
  withDb(root, (db) => {
    db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON summary BEGIN SELECT RAISE(ABORT, 'boom'); END;")
  })

  await submitBoth(root, 'B区')
  assert.equal((await doCompare({ cwd: root })).ok, true)
  const second = await doApply({ cwd: root })
  assert.equal(second.ok, false)
  assert.equal(second.error, '写入失败')
  assert.match(second.errors.join('；'), /boom/)

  const ledgerAfter = withDb(root, (db) => db.prepare('SELECT COUNT(*) AS c FROM ledger').get().c)
  assert.equal(ledgerAfter, ledgerBefore, '失败的落表不能追加 ledger')
  const value = withDb(root, (db) => db.prepare('SELECT location FROM summary WHERE record_id = ?').get('CASE-0001').location)
  assert.equal(value, 'A区', '失败的落表必须回滚到旧值')
  const applied = withDb(root, (db) => db.prepare('SELECT COUNT(*) AS c FROM applied').get().c)
  assert.equal(applied, 1)
  await rm(root, { recursive: true, force: true })
})

test('落表成功时 ledger 与 applied 和表值一起提交', async () => {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  assert.equal((await doContract({ cwd: root, contract: contractOf() })).ok, true)
  await submitBoth(root, 'A区')
  assert.equal((await doCompare({ cwd: root })).ok, true)
  const res = await doApply({ cwd: root })
  assert.equal(res.ok, true, res.error)

  const row = withDb(root, (db) => ({
    value: db.prepare('SELECT location FROM summary WHERE record_id = ?').get('CASE-0001').location,
    ledger: db.prepare('SELECT COUNT(*) AS c FROM ledger').get().c,
    applied: db.prepare('SELECT COUNT(*) AS c FROM applied').get().c,
  }))
  assert.equal(row.value, 'A区')
  assert.equal(row.ledger, 1)
  assert.equal(row.applied, 1)
  await rm(root, { recursive: true, force: true })
})

test('dryRun 不写 curated 表、不写 ledger 与 applied', async () => {
  const root = await makeProject()
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  assert.equal((await doContract({ cwd: root, contract: contractOf() })).ok, true)
  await submitBoth(root, 'A区')
  assert.equal((await doCompare({ cwd: root })).ok, true)

  const dry = await doApply({ cwd: root, dryRun: true })
  assert.equal(dry.ok, true, dry.error)
  assert.equal(dry.applied, 1)
  const state = withDb(root, (db) => ({
    tables: db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'summary'").get().c,
    ledger: db.prepare('SELECT COUNT(*) AS c FROM ledger').get().c,
    applied: db.prepare('SELECT COUNT(*) AS c FROM applied').get().c,
  }))
  assert.equal(state.tables, 0)
  assert.equal(state.ledger, 0)
  assert.equal(state.applied, 0)
  await rm(root, { recursive: true, force: true })
})
