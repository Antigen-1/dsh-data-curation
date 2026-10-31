import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adjudicate } from '../lib/adjudicate.js'
import { doCompare, doInit, doPin, doSubmit } from '../lib/core.js'
import { toPin } from './_pin.js'

const SCRIPT = `import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const payload = JSON.parse(readFileSync(0, 'utf8'))
const here = dirname(fileURLToPath(import.meta.url))
appendFileSync(join(here, 'calls.log'), JSON.stringify({ kind: payload.kind, cells: payload.cells?.length ?? 1 }) + '\\n')

let mode = 'ok'
try { mode = JSON.parse(readFileSync(join(here, 'mode.json'), 'utf8')).mode } catch {}

if (payload.kind === 'select-batch') {
  let results = payload.cells.map((c) => ({ record: c.record, field: c.field, index: 0 }))
  if (mode === 'missing') results = results.slice(0, -1)
  if (mode === 'badindex') results = results.map((r, i) => (i === 0 ? { ...r, index: 99 } : r))
  if (mode === 'duplicate') results = [results[0], ...results]
  process.stdout.write(JSON.stringify({ results }))
} else {
  process.stdout.write(JSON.stringify({ index: 0 }))
}
`

async function makeRoot(mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-select-batch-'))
  await mkdir(join(root, 'policy'), { recursive: true })
  await writeFile(join(root, 'policy', 'pick.mjs'), SCRIPT, 'utf8')
  await writeFile(join(root, 'policy', 'mode.json'), JSON.stringify({ mode }), 'utf8')
  return root
}

const contractOf = (batch = true) => ({
  fields: [
    { name: 'size', allowEmpty: true },
    { name: 'note', allowEmpty: true },
  ],
  records: { kind: 'list', values: ['R1', 'R2', 'R3'] },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  evidence: { required: false },
  adjudication: {
    select: batch
      ? { command: 'node', args: ['policy/pick.mjs'], batch: true }
      : { command: 'node', args: ['policy/pick.mjs'] },
  },
})

const byRecord = new Map(['R1', 'R2', 'R3'].map((r) => [r, [
  { channel: 'text', status: 'valid', values: { size: '1.2cm', note: `n-${r}` }, evidence: {} },
  { channel: 'vision', status: 'valid', values: { size: '1.2cm', note: `n-${r}` }, evidence: {} },
]]))

async function callsOf(root) {
  const text = await readFile(join(root, 'policy', 'calls.log'), 'utf8')
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('select-batch：一次命令判完全部格，答案按 record+field 回填', async () => {
  const root = await makeRoot()
  const decisions = adjudicate({ contract: contractOf(), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root })
  assert.equal(decisions.length, 6)
  assert.ok(decisions.every((d) => d.status === 'accepted'), JSON.stringify(decisions))
  const calls = await callsOf(root)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'select-batch')
  assert.equal(calls[0].cells, 6)
})

test('select-batch：缺一条结果只影响那一格，其余照常接受', async () => {
  const root = await makeRoot('missing')
  const decisions = adjudicate({ contract: contractOf(), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root })
  const pending = decisions.filter((d) => d.status === 'pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].reason, 'adjudicator_error')
  assert.match(pending[0].detail, /缺少结果/)
  assert.equal(decisions.filter((d) => d.status === 'accepted').length, 5)
})

test('select-batch：下标越界只把该格标成 adjudicator_error', async () => {
  const root = await makeRoot('badindex')
  const decisions = adjudicate({ contract: contractOf(), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root })
  const pending = decisions.filter((d) => d.status === 'pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].reason, 'adjudicator_error')
  assert.match(pending[0].detail, /下标越界/)
})

test('select-batch：重复结果只把该格标成 adjudicator_error，其余照常接受', async () => {
  const root = await makeRoot('duplicate')
  const decisions = adjudicate({ contract: contractOf(), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root })
  const pending = decisions.filter((d) => d.status === 'pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].record, 'R1')
  assert.equal(pending[0].field, 'size')
  assert.equal(pending[0].reason, 'adjudicator_error')
  assert.match(pending[0].detail, /重复的格/)
  assert.equal(decisions.filter((d) => d.status === 'accepted').length, 5)
})

test('select-batch：pin 签署后经 compare 一次命令判完全部格', async () => {
  const root = await makeRoot()
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'source.txt'), 'synthetic source\n', 'utf8')
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  const signed = await doPin({ cwd: root, pin: toPin(contractOf()) })
  assert.equal(signed.ok, true, JSON.stringify(signed.errors))
  for (const channel of ['text', 'vision']) {
    const submitted = await doSubmit({
      cwd: root, channel, batch: 'B001',
      records: ['R1', 'R2', 'R3'].map((record_id) => ({
        record_id, status: 'valid', values: { size: '1.2cm', note: `n-${record_id}` }, evidence: {},
      })),
    })
    assert.equal(submitted.ok, true, submitted.error)
  }
  const compared = await doCompare({ cwd: root, scope: 'all' })
  assert.equal(compared.ok, true, compared.error)
  assert.equal(compared.accepted, 6)
  assert.equal(compared.pending, 0)
  const calls = await callsOf(root)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { kind: 'select-batch', cells: 6 })
})

test('未开 batch 时仍然逐格调用（兼容旧 pin）', async () => {
  const root = await makeRoot()
  adjudicate({ contract: contractOf(false), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root })
  const calls = await callsOf(root)
  assert.equal(calls.length, 6)
  assert.ok(calls.every((c) => c.kind === 'select'))
})
