import assert from 'node:assert/strict'
import test from 'node:test'
import { queryLines, statusLines, verifyLines } from '../lib/format.js'

test('statusLines 渲染正常状态', () => {
  const lines = statusLines({
    stateDir: '.curation',
    workspace: '.curation/project.sqlite',
    manifest: null,
    project: { name: 'demo', description: null },
    pin: { version: 5, id: 'pin-abc', hash: 'abcdef0123456789', tables: 1, pinnedAt: '2026-01-01T00:00:00Z', defaults: {} },
    tables: [{ table: 'summary', status: 'active', revision: 2, fields: 2, channels: ['text', 'vision'], key: 'record_id', rows: 2, columns: 2 }],
    exporters: { builtins: [{ name: 'csv' }, { name: 'jsonl' }], project: [{ name: 'xlsx' }] },
    channels: [{ channel: 'text', submissions: 3, lastAt: '2026-01-01T00:00:00Z' }],
    decisions: { total: 4, accepted: 3, pending: 1, byReason: { missing_evidence: 1 } },
    applied: { applied_at: '2026-01-01T00:00:00Z', ops: 3, backup: '.curation/backups/x.sqlite' },
    pendingFile: '.curation/pending.json',
  })
  const text = lines.join('\n')
  assert.match(text, /工作区：\.curation\/project\.sqlite/)
  assert.match(text, /pin：v5 .*1 张表/)
  assert.match(text, /表 summary \[active\]：rev 2，2 字段 \/ 通道 text,vision \/ 交付键 record_id \/ curated 2 行 \/ 2 列/)
  assert.match(text, /导出器：内置 csv\/jsonl；项目 xlsx/)
  assert.match(text, /比对：共 4 格，接受 3，待裁定 1/)
  assert.match(text, /待裁定原因：missing_evidence=1/)

  assert.match(text, /待裁定清单：\.curation\/pending\.json/)
})

test('statusLines 渲染尚未生成的交付表', () => {
  const lines = statusLines({
    stateDir: '.curation',
    workspace: '.curation/project.sqlite',
    manifest: null,
    project: null,
    pin: null,
    tables: [],
    channels: [],
    decisions: { total: 0, accepted: 0, pending: 0 },
    applied: null,
  })
  const text = lines.join('\n')
  assert.match(text, /pin：未签署/)
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

test('verifyLines 把 FAIL 当结论渲染，而不是「操作失败」', () => {
  const lines = verifyLines({
    ok: false,
    status: 'FAIL',
    checks: [{ name: 'manifest_intact', status: 'fail', detail: '源基线漂移' }],
    accepted: 0,
    pending: 3,
    total: 3,
    pendingByReason: { no_valid_channel: 2, missing_evidence: 1 },
  })
  const text = lines.join('\n')
  assert.equal(lines[0], '验收结果：FAIL')
  assert.match(text, /✗ manifest_intact: 源基线漂移/)
  assert.match(text, /待裁定原因：no_valid_channel=2，missing_evidence=1/)
  assert.doesNotMatch(text, /操作失败/)
})

test('verifyLines 在没有 checks 且没有 error 时才显示「操作失败」', () => {
  assert.deepEqual(verifyLines({ ok: false }), ['✗ 操作失败'])
  assert.deepEqual(verifyLines({ ok: false, error: '锁被占用' }), ['✗ 锁被占用'])
})

test('queryLines 渲染 counts / pending / votes / json', () => {
  const counts = queryLines({
    ok: true,
    what: 'counts',
    data: {
      decisions: { total: 6, accepted: 4, pending: 2, byReason: { no_two_channel_agreement: 2 }, byField: [{ field: 'size', accepted: 2, pending: 1 }] },
      submissions: [{ channel: 'text', batches: 1, records: 3 }],
      runs: { total: 2, lastAt: '2026-10-30T00:00:00Z' },
      applied: { ops: 4, appliedAt: '2026-10-30T00:10:00Z' },
    },
  }).join('\n')
  assert.match(counts, /结论：接受 4 \/ 待裁定 2（共 6 格）/)
  assert.match(counts, /待裁定原因：no_two_channel_agreement=2/)
  assert.match(counts, /落表：写入 4 格/)

  const pending = queryLines({
    ok: true,
    what: 'pending',
    data: [{ record: 'CASE-0001', field: 'size', reason: 'competing_majorities', channels: ['text=1.2cm', 'vision=1.3cm'] }],
  }).join('\n')
  assert.match(pending, /CASE-0001/)
  assert.match(pending, /competing_majorities/)
  assert.match(pending, /text=1\.2cm,vision=1\.3cm/)

  const votes = queryLines({
    ok: true,
    what: 'votes',
    data: { record: 'CASE-0001', field: 'size', found: true, status: 'accepted', votes: [
      { channel: 'text', valid: true, present: true, raw: '1.2cm', evidence: { page: 3 } },
      { channel: 'vision', valid: false, present: true, raw: '?' },
    ] },
  }).join('\n')
  assert.match(votes, /✓ text: 1\.2cm \[p3\]/)
  assert.match(votes, /✗ vision: \?/)

  const asJson = queryLines({ ok: true, what: 'counts', data: { decisions: { total: 1 } } }, { format: 'json' }).join('\n')
  assert.equal(JSON.parse(asJson).decisions.total, 1)
})
