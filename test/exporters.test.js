import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  backendNames, listExporters, registerExporter, resolveExporter, runExporter, unregisterExporter,
} from '../lib/exporters.js'

const ROWS = [
  { record_id: 'CASE-0001', location: 'A区', note: 'line|pipe\nbreak' },
  { record_id: 'CASE-0002', location: 'B区', note: '' },
]

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-export-'))
  await mkdir(join(root, 'tools'), { recursive: true })
  return root
}

const ctx = (root, out, extra = {}) => ({
  cwd: root,
  table: 'summary',
  key: 'record_id',
  columns: ['record_id', 'location', 'note'],
  rows: ROWS,
  fields: [{ name: 'location', type: 'text' }, { name: 'note', type: 'text' }],
  external: {},
  out: join(root, out),
  ...extra,
})

test('内置导出器：csv / jsonl / markdown / sqlite', async () => {
  assert.deepEqual(backendNames().sort(), ['csv', 'jsonl', 'markdown', 'sqlite'])
  for (const e of listExporters()) assert.ok(e.name && e.extension && e.description)

  const root = await sandbox()

  const csv = await runExporter('csv', ctx(root, 'out.csv'))
  assert.equal(csv.rows, 2)
  assert.equal(await readFile(join(root, 'out.csv'), 'utf8'), 'record_id,location,note\nCASE-0001,A区,"line|pipe\nbreak"\nCASE-0002,B区,\n')

  await runExporter('jsonl', ctx(root, 'out.jsonl'))
  const lines = (await readFile(join(root, 'out.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).record_id, 'CASE-0001')

  await runExporter('markdown', ctx(root, 'out.md'))
  const md = await readFile(join(root, 'out.md'), 'utf8')
  assert.match(md, /^\| record_id \| location \| note \|$/m)
  assert.match(md, /line\\\|pipe<br>break/)

  await runExporter('sqlite', ctx(root, 'out.sqlite'))
  const db = new DatabaseSync(join(root, 'out.sqlite'))
  try {
    const rows = db.prepare('SELECT record_id, location, note FROM summary ORDER BY record_id').all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].location, 'A区')
  } finally {
    db.close()
  }
})

test('未注册格式报错时列出可用格式', async () => {
  assert.throws(() => resolveExporter('parquet', { xlsx: { command: 'node x.mjs' } }), /未注册的导出格式：parquet（可用：csv, jsonl, markdown, sqlite, xlsx）/)
})

test('registerExporter 注册的自定义格式可运行，也可注销', async () => {
  const root = await sandbox()
  const target = join(root, 'custom.txt')
  registerExporter({
    name: 'upper',
    extension: 'txt',
    kind: 'custom',
    description: '测试用：仅保留记录键',
    async run({ rows, out }) {
      const { writeFile: wf } = await import('node:fs/promises')
      await wf(out, rows.map((r) => r.record_id).join(','), 'utf8')
      return { rows: rows.length, columns: 1 }
    },
  })
  try {
    assert.ok(backendNames().includes('upper'))
    const result = await runExporter('upper', ctx(root, 'custom.txt'))
    assert.equal(result.extension, 'txt')
    assert.equal(await readFile(target, 'utf8'), 'CASE-0001,CASE-0002')
  } finally {
    assert.equal(unregisterExporter('upper'), true)
  }
  assert.ok(!backendNames().includes('upper'))
})

test('项目外部导出器：stdin 收 JSON、写入 $CURATION_EXPORT_OUT', async () => {
  const root = await sandbox()
  await writeFile(join(root, 'tools', 'export-upper.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "const input = JSON.parse(readFileSync(0, 'utf8'))",
    "const out = process.env.CURATION_EXPORT_OUT",
    "const rows = input.rows.map((r) => ({ ...r, location: String(r.location).toUpperCase() }))",
    "writeFileSync(out, JSON.stringify({ table: input.table, key: input.key, rows }), 'utf8')",
    '',
  ].join('\n'), 'utf8')

  const external = { upper: { command: 'node tools/export-upper.mjs' } }
  const result = await runExporter('upper', ctx(root, 'external.json', { external }))
  assert.equal(result.kind, 'external')
  const payload = JSON.parse(await readFile(join(root, 'external.json'), 'utf8'))
  assert.equal(payload.table, 'summary')
  assert.equal(payload.key, 'record_id')
  assert.equal(payload.rows[0].location, 'A区') // toUpperCase 不影响中文
})

test('外部导出器非零退出时报出退出码', async () => {
  const root = await sandbox()
  const external = { broken: { command: 'node -e "process.exit(3)"' } }
  await assert.rejects(() => runExporter('broken', ctx(root, 'broken.out', { external })), /退出码 3/)
})

test('外部导出器没有写出文件时报错', async () => {
  const root = await sandbox()
  const external = { lazy: { command: 'node -e "process.exit(0)"' } }
  await assert.rejects(() => runExporter('lazy', ctx(root, 'lazy.out', { external })), /没有写出文件/)
})
