import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doPin } from '../lib/core.js'
import { doIdentity, doPinDraft, doRecordsImport } from '../lib/intake.js'

async function rootWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-intake-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return root
}

async function initWithRaw(root) {
  const { doInit } = await import('../lib/core.js')
  const out = await doInit({ cwd: root, sources: ['raw'] })
  assert.equal(out.ok, true, JSON.stringify(out))
}

test('records_import 从 CSV 导入键列、推断字段并报告重复/缺键', async () => {
  const root = await rootWith({
    'raw/doc.txt': 'CASE-1 CASE-2\n',
    'input/records.csv': 'record_id,location,note\nCASE-1,A区,ok\nCASE-2,B区,\nCASE-2,A区,dup\n,C区,missing\n',
  })
  try {
    const out = await doRecordsImport({ cwd: root, path: 'input/records.csv', key: 'record_id' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.count, 2)
    assert.equal(out.missing, 1)
    assert.equal(out.duplicateTotal, 1)
    assert.deepEqual(out.fields.map((f) => f.name), ['location', 'note'])
    assert.equal(out.fields[1].allowEmpty, true)
    const text = await readFile(join(root, out.path), 'utf8')
    assert.match(text, /CASE-1/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pin_draft 从导入记录生成草稿，草稿可直接签署', async () => {
  const root = await rootWith({
    'raw/doc.txt': 'CASE-1 CASE-2\n',
    'input/records.csv': 'record_id,location,note\nCASE-1,A区,ok\nCASE-2,B区,\n',
  })
  try {
    await initWithRaw(root)
    const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv' })
    assert.equal(imported.ok, true, JSON.stringify(imported))
    const draft = await doPinDraft({
      cwd: root, recordsPath: imported.path, key: 'record_id', table: 'summary', project: 'draft-test',
    })
    assert.equal(draft.ok, true, JSON.stringify(draft))
    assert.deepEqual(draft.fields, ['location', 'note'])
    assert.equal(draft.records, 2)
    const signed = await doPin({ cwd: root, draftPath: draft.draftPath })
    assert.equal(signed.ok, true, JSON.stringify(signed))
    assert.match(signed.hash, /^[a-f0-9]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('identity 支持改号/排除/文件映射并写审计', async () => {
  const root = await rootWith({
    'raw/doc.txt': 'OLD-1 OLD-2 OLD-3\n',
    'input/records.csv': 'record_id,location\nOLD-1,A\nOLD-2,B\nOLD-3,C\n',
  })
  try {
    const out = await doIdentity({
      cwd: root, path: 'input/records.csv', table: 'summary',
      rename: { 'OLD-1': 'CASE-1' }, exclude: ['OLD-3'], fileMap: { 'CASE-1': 'raw/001.pdf' },
    })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.count, 2)
    assert.equal(out.renamed, 1)
    assert.equal(out.excluded, 1)
    assert.equal(out.files, 1)
    const rows = (await readFile(join(root, out.path), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(rows[0].record_id, 'CASE-1')
    assert.equal(rows[0].__source, 'raw/001.pdf')
    const audit = JSON.parse(await readFile(join(root, out.auditPath), 'utf8'))
    assert.equal(audit.excluded[0], 'OLD-3')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('identity 改号后重复键整体拒绝', async () => {
  const root = await rootWith({
    'raw/doc.txt': 'A B\n',
    'input/records.csv': 'record_id,location\nA,x\nB,y\n',
  })
  try {
    const out = await doIdentity({ cwd: root, path: 'input/records.csv', rename: { A: 'B' } })
    assert.equal(out.ok, false)
    assert.match(out.error, /重复键/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('records_import 对 Excel 给出明确迁移建议', async () => {
  const root = await rootWith({ 'raw/doc.txt': 'x\n' })
  try {
    const out = await doRecordsImport({ cwd: root, path: 'input/records.xlsx' })
    assert.equal(out.ok, false)
    assert.match(out.error, /导出为 CSV 或 JSONL/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pin_draft 无记录时生成带警告的草稿而不签署', async () => {
  const root = await rootWith({ 'raw/doc.txt': 'x\n' })
  try {
    const out = await doPinDraft({ cwd: root, table: 'summary', project: 'empty' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.ok(out.warnings.some((w) => w.includes('记录集为空')))
    assert.equal(out.records, 0)
    const signed = await doPin({ cwd: root, draftPath: out.draftPath })
    assert.equal(signed.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('submit from JSONL 批量导入一个通道', async () => {
  const root = await rootWith({
    'raw/doc.txt': 'CASE-1 CASE-2\n',
    'input/records.csv': 'record_id,location,note\nCASE-1,A区,ok\nCASE-2,B区,\n',
    'input/submissions.jsonl': [
      JSON.stringify({ record_id: 'CASE-1', status: 'valid', values: { location: 'A区', note: 'ok' }, evidence: { location: { page: 1, quote: 'A区' } } }),
      JSON.stringify({ record_id: 'CASE-2', status: 'valid', values: { location: 'B区', note: '' } }),
    ].join('\n'),
  })
  try {
    await initWithRaw(root)
    const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv' })
    const draft = await doPinDraft({ cwd: root, recordsPath: imported.path, table: 'summary' })
    const signed = await doPin({ cwd: root, draftPath: draft.draftPath })
    assert.equal(signed.ok, true, JSON.stringify(signed))
    const { doSubmit } = await import('../lib/core.js')
    const out = await doSubmit({ cwd: root, channel: 'text', batch: 'B001', from: 'input/submissions.jsonl' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.records, 2)
    assert.equal(out.from, 'input/submissions.jsonl')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('job 分块提交 450 条并写检查点，可查询状态', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => `CASE-${String(i + 1).padStart(3, '0')}`)
  const csv = ['record_id,location', ...rows.map((id) => `${id},A`)].join('\n')
  const jsonl = rows.map((id) => JSON.stringify({ record_id: id, values: { location: 'A' } })).join('\n')
  const root = await rootWith({
    'raw/doc.txt': rows.join(' '),
    'input/records.csv': csv,
    'input/submissions.jsonl': jsonl,
  })
  try {
    await initWithRaw(root)
    const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv' })
    const draft = await doPinDraft({ cwd: root, recordsPath: imported.path, table: 'summary' })
    const signed = await doPin({ cwd: root, draftPath: draft.draftPath })
    assert.equal(signed.ok, true, JSON.stringify(signed))
    const { doJob } = await import('../lib/jobs.js')
    const started = await doJob({
      cwd: root, action: 'start', from: 'input/submissions.jsonl', channel: 'text', batch: 'B001', chunkSize: 200,
    })
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.job.total, 450)
    assert.equal(started.job.submitted, 450)
    assert.equal(started.job.offset, 450)
    assert.equal(started.job.status, 'completed')
    const status = await doJob({ cwd: root, action: 'status', jobId: started.job.jobId })
    assert.equal(status.ok, true)
    assert.equal(status.job.status, 'completed')
    const list = await doJob({ cwd: root, action: 'list' })
    assert.ok(list.jobs.some((j) => j.jobId === started.job.jobId))
    const resume = await doJob({ cwd: root, action: 'resume', jobId: started.job.jobId })
    assert.equal(resume.ok, false)
    assert.match(resume.error, /已结束/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('coverage 查询给出字段级提交/接受/待裁定', async () => {
  const root = await rootWith({
    'raw/doc.txt': 'CASE-1 CASE-2\n',
    'input/records.csv': 'record_id,location\nCASE-1,A\nCASE-2,B\n',
  })
  try {
    await initWithRaw(root)
    const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv' })
    const draft = await doPinDraft({ cwd: root, recordsPath: imported.path, table: 'summary' })
    const signed = await doPin({ cwd: root, draftPath: draft.draftPath })
    assert.equal(signed.ok, true, JSON.stringify(signed))
    const { doSubmit, doCompare, doQuery } = await import('../lib/core.js')
    const text = await doSubmit({ cwd: root, channel: 'text', batch: 'B1', records: [
      { record_id: 'CASE-1', values: { location: 'A' }, evidence: { location: { page: 1, quote: 'A' } } },
      { record_id: 'CASE-2', values: { location: 'B' }, evidence: { location: { page: 1, quote: 'B' } } },
    ] })
    assert.equal(text.ok, true, JSON.stringify(text))
    const vision = await doSubmit({ cwd: root, channel: 'vision', batch: 'B1', records: [
      { record_id: 'CASE-1', values: { location: 'A' }, evidence: { location: { page: 1, quote: 'A' } } },
      { record_id: 'CASE-2', values: { location: 'B' }, evidence: { location: { page: 1, quote: 'B' } } },
    ] })
    assert.equal(vision.ok, true, JSON.stringify(vision))
    const compared = await doCompare({ cwd: root })
    assert.equal(compared.ok, true, JSON.stringify(compared))
    const out = await doQuery({ cwd: root, what: 'coverage' })
    assert.equal(out.ok, true, JSON.stringify(out))
    const field = out.data[0].fields.find((f) => f.field === 'location')
    assert.equal(field.submitted, 2)
    assert.equal(field.accepted, 2)
    assert.equal(field.pending, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
