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

async function prepared() {
  const root = await rootWith({
    'raw/doc.txt': 'CASE-1 A\nCASE-2 B\n',
    'input/records.csv': 'record_id,location\nCASE-1,A\nCASE-2,B\n',
  })
  await doInit({ cwd: root, sources: ['raw'] })
  const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv' })
  const draft = await doPinDraft({ cwd: root, recordsPath: imported.path, table: 'summary' })
  const signed = await doPin({ cwd: root, draftPath: draft.draftPath })
  assert.equal(signed.ok, true, JSON.stringify(signed))
  const records = [
    { record_id: 'CASE-1', values: { location: 'A' }, evidence: { location: { page: 1, quote: 'A' } } },
    { record_id: 'CASE-2', values: { location: 'B' }, evidence: { location: { page: 1, quote: 'B' } } },
  ]
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
    const tableFile = join(root, built.manifest.tables[0].file)
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
