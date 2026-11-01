import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { doInit, doPin } from '../lib/core.js'
import { doRecordsImport, doPinDraft } from '../lib/intake.js'
import { doSubmit, doCompare, doApply, doVerify, doQuery } from '../lib/core.js'

async function rootWith(files) {
  const root = await fs.mkdtemp(join(tmpdir(), 'curation-protected-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, content)
  }
  return root
}

test('受保护列不落表、不进 ledger，verify 仍 PASS', async () => {
  const root = await rootWith({
    'raw/doc.txt': 'CASE-1 A\n',
    'input/records.csv': 'record_id,location\nCASE-1,A\n',
  })
  try {
    await doInit({ cwd: root, sources: ['raw'] })
    const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv' })
    const draft = await doPinDraft({ cwd: root, recordsPath: imported.path, table: 'summary' })
    const draftAbs = join(root, draft.draftPath)
    const pin = JSON.parse(await fs.readFile(draftAbs, 'utf8'))
    pin.tables[0].fields.push({ name: 'reviewer', type: 'text', allowEmpty: true, protected: true })
    await fs.writeFile(draftAbs, `${JSON.stringify(pin, null, 2)}\n`)
    const signed = await doPin({ cwd: root, draftPath: draft.draftPath })
    assert.equal(signed.ok, true, JSON.stringify(signed))
    const records = [
      { record_id: 'CASE-1', values: { location: 'A', reviewer: '张三' }, evidence: { location: { page: 1, quote: 'A' }, reviewer: { page: 1, quote: '张三' } } },
    ]
    assert.equal((await doSubmit({ cwd: root, channel: 'text', batch: 'B1', records })).ok, true)
    assert.equal((await doSubmit({ cwd: root, channel: 'vision', batch: 'B1', records })).ok, true)
    assert.equal((await doCompare({ cwd: root })).ok, true)
    const applied = await doApply({ cwd: root })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.changed, 1)
    assert.equal(applied.protectedSkipped, 1)
    const cells = await doQuery({ cwd: root, what: 'cells' })
    const reviewer = cells.data.find((c) => c.field === 'reviewer')
    assert.equal(reviewer.status, 'accepted')
    const verified = await doVerify({ cwd: root })
    assert.equal(verified.status, 'PASS', JSON.stringify(verified))
    assert.equal(verified.tables[0].checks.find((c) => c.name === 'delivery_matches').status, 'pass')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
