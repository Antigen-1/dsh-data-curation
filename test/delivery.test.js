import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { doInit, doPin, doSubmit, doCompare, doApply, doVerify } from '../lib/core.js'
import { doRecordsImport, doPinDraft } from '../lib/intake.js'
import { doDeliveryPlan, doVerifyDelivery } from '../lib/delivery-plan.js'

async function rootWith(files) {
  const root = await fs.mkdtemp(join(tmpdir(), 'curation-delivery-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, content)
  }
  return root
}

async function prepared(locations = ['A', 'B']) {
  const root = await rootWith({
    'raw/doc.txt': 'CASE-1 A\nCASE-2 B\n',
    'input/records.csv': 'record_id,location\nCASE-1,A\nCASE-2,B\n',
  })
  await doInit({ cwd: root, sources: ['raw'] })
  const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv' })
  const draft = await doPinDraft({ cwd: root, recordsPath: imported.path, table: 'summary' })
  const signed = await doPin({ cwd: root, draftPath: draft.draftPath })
  assert.equal(signed.ok, true, JSON.stringify(signed))
  const records = locations.map((location, index) => ({
    record_id: `CASE-${index + 1}`,
    values: { location },
    evidence: { location: { page: 1, quote: location } },
  }))
  assert.equal((await doSubmit({ cwd: root, channel: 'text', batch: 'B1', records })).ok, true)
  assert.equal((await doSubmit({ cwd: root, channel: 'vision', batch: 'B1', records })).ok, true)
  assert.equal((await doCompare({ cwd: root })).ok, true)
  const applied = await doApply({ cwd: root })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  return root
}

test('交付包 build/verify 与 tamper 检测', async () => {
  const root = await prepared()
  try {
    const built = await doDeliveryPlan({ cwd: root, action: 'build' })
    assert.equal(built.ok, true, JSON.stringify(built))
    assert.ok(built.files.some((f) => f.endsWith('delivery.json')))
    const verified = await doVerifyDelivery({ cwd: root, path: built.path })
    assert.equal(verified.status, 'PASS', JSON.stringify(verified))
    assert.ok(verified.checks.every((c) => c.status === 'pass'))
    const tableFile = join(root, built.path, built.manifest.tables[0].file)
    await fs.appendFile(tableFile, '{"record_id":"TAMPER"}\n')
    const tampered = await doVerifyDelivery({ cwd: root, path: built.path })
    assert.equal(tampered.status, 'FAIL')
    assert.equal(tampered.checks.find((c) => c.name.startsWith('table:')).status, 'fail')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delivery plan 可声明两张表并拒绝未登记表', async () => {
  const root = await prepared()
  try {
    const written = await doDeliveryPlan({ cwd: root, action: 'write', plan: { name: 'pkg', tables: ['summary'] } })
    assert.equal(written.ok, true, JSON.stringify(written))
    const shown = await doDeliveryPlan({ cwd: root, action: 'show' })
    assert.equal(shown.plan.tables[0].table, 'summary')
    const bad = await doDeliveryPlan({ cwd: root, action: 'write', plan: { tables: ['nope'] } })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /未登记|退役/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CSV 交付包按数据行验收并支持引号内换行', async () => {
  const root = await prepared(['A\nA2', 'B'])
  try {
    const built = await doDeliveryPlan({
      cwd: root,
      action: 'build',
      plan: { name: 'csv', tables: [{ table: 'summary', format: 'csv' }] },
    })
    assert.equal(built.ok, true, JSON.stringify(built))
    assert.equal(built.manifest.tables[0].rows, 2)
    const tableText = await fs.readFile(join(root, built.path, built.manifest.tables[0].file), 'utf8')
    assert.match(tableText, /"A\nA2"/)
    const verified = await doVerifyDelivery({ cwd: root, path: built.path })
    assert.equal(verified.status, 'PASS', JSON.stringify(verified))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('交付包复制后独立验收，副本篡改不会检查原包', async () => {
  const root = await prepared()
  try {
    const built = await doDeliveryPlan({ cwd: root, action: 'build' })
    assert.equal(built.ok, true, JSON.stringify(built))
    assert.equal(built.manifest.tables[0].file, 'tables/summary.jsonl')
    const original = join(root, built.path)
    const copied = join(root, 'copied-package')
    await fs.cp(original, copied, { recursive: true })
    const copiedTable = join(copied, built.manifest.tables[0].file)
    await fs.appendFile(copiedTable, '{"record_id":"TAMPER"}\n')
    const tampered = await doVerifyDelivery({ cwd: root, path: 'copied-package' })
    assert.equal(tampered.status, 'FAIL', JSON.stringify(tampered))
    assert.equal(tampered.checks.find((c) => c.name.startsWith('table:')).status, 'fail')

    await fs.rm(copied, { recursive: true, force: true })
    await fs.cp(original, copied, { recursive: true })
    await fs.rm(original, { recursive: true, force: true })
    const moved = await doVerifyDelivery({ cwd: root, path: 'copied-package' })
    assert.equal(moved.status, 'PASS', JSON.stringify(moved))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('交付计划拒绝越界路径与未知格式', async () => {
  const root = await prepared()
  try {
    const invalidPlans = [
      { name: '../escaped', tables: ['summary'] },
      { name: 'pkg', tables: ['summary'], pending: { file: '../pending.csv' } },
      { name: 'pkg', tables: ['summary'], review: { file: '../review.md' } },
      { name: 'pkg', tables: ['summary'], review: { file: '/tmp/review.md' } },
      { name: 'pkg', tables: [{ table: 'summary', format: 'yaml' }] },
    ]
    for (const plan of invalidPlans) {
      const result = await doDeliveryPlan({ cwd: root, action: 'write', plan })
      assert.equal(result.ok, false, JSON.stringify(result))
      assert.match(result.error, /交付目录|不支持的格式/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
