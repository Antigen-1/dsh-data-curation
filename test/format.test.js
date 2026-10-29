import assert from 'node:assert/strict'
import test from 'node:test'
import { statusLines, verifyLines } from '../lib/format.js'

test('statusLines 渲染正常状态', () => {
  const lines = statusLines({
    stateDir: '.curation',
    workspace: '.curation/project.sqlite',
    manifest: null,
    contract: { version: 3, hash: 'abcdef0123456789', fields: 2, channels: ['text', 'vision'], delivery: { table: 'summary' } },
    exporters: { builtins: [{ name: 'csv' }, { name: 'jsonl' }], project: [{ name: 'xlsx' }] },
    channels: [{ channel: 'text', submissions: 3, lastAt: '2026-01-01T00:00:00Z' }],
    decisions: { total: 4, accepted: 3, pending: 1, byReason: { missing_evidence: 1 } },
    delivery: { table: 'summary', rows: 2, columns: 2 },
    applied: { applied_at: '2026-01-01T00:00:00Z', ops: 3, backup: '.curation/backups/x.sqlite' },
    pendingFile: '.curation/pending.json',
  })
  const text = lines.join('\n')
  assert.match(text, /工作区：\.curation\/project\.sqlite/)
  assert.match(text, /契约：v3 .* 2 字段 \/ 通道 text,vision \/ 交付表 summary/)
  assert.match(text, /导出器：内置 csv\/jsonl；项目 xlsx/)
  assert.match(text, /比对：共 4 格，接受 3，待裁定 1/)
  assert.match(text, /待裁定原因：missing_evidence=1/)
  assert.match(text, /交付表：summary（工作区内，2 行 \/ 2 列）/)
  assert.match(text, /待裁定清单：\.curation\/pending\.json/)
})

test('statusLines 渲染尚未生成的交付表', () => {
  const lines = statusLines({
    stateDir: '.curation',
    workspace: '.curation/project.sqlite',
    manifest: null,
    contract: null,
    channels: [],
    decisions: { total: 0, accepted: 0, pending: 0 },
    delivery: null,
    applied: null,
  })
  const text = lines.join('\n')
  assert.match(text, /契约：未冻结/)
  assert.match(text, /提交：无/)
  assert.match(text, /最近落表：无/)
})

test('statusLines 与 verifyLines 能渲染错误结果而不抛异常', () => {
  assert.deepEqual(statusLines({ ok: false, error: '尚未建立源基线' }), ['✗ 尚未建立源基线'])
  assert.deepEqual(verifyLines({ ok: false, error: 'boom' }), ['✗ boom'])
})

test('verifyLines 用 ✓/!/✗ 标注检查项', () => {
  const lines = verifyLines({
    status: 'CONDITIONAL',
    checks: [
      { name: 'manifest_intact', status: 'pass', detail: 'ok' },
      { name: 'pending_cells', status: 'conditional', detail: '2 格待裁定' },
      { name: 'delivery_matches', status: 'fail', detail: '1 格不一致' },
    ],
  })
  assert.equal(lines[0], '验收结果：CONDITIONAL')
  assert.match(lines[1], /^✓ manifest_intact/)
  assert.match(lines[2], /^! pending_cells/)
  assert.match(lines[3], /^✗ delivery_matches/)
})
