import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adjudicate } from '../lib/adjudicate.js'
import { validateContract } from '../lib/contract.js'

const SCRIPT = `import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const payload = JSON.parse(readFileSync(0, 'utf8'))
const here = dirname(fileURLToPath(import.meta.url))
appendFileSync(join(here, 'calls.log'), JSON.stringify({ kind: payload.kind, cells: payload.cells?.length ?? 1 }) + '\\n')

let mode = 'ok'
try { mode = JSON.parse(readFileSync(join(here, 'mode.json'), 'utf8')).mode } catch {}
if (payload.kind === 'compare-batch') {
  const cells = payload.cells.map((c) => ({ record: c.record, field: c.field, groups: [[0, 1]] }))
  if (mode === 'missing') cells.pop()
  if (mode === 'duplicate') cells.push({ ...cells[0] })
  process.stdout.write(JSON.stringify({ results: cells }))
} else {
  process.stdout.write(JSON.stringify({ groups: [[0, 1]] }))
}
`

async function makeRoot(mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-batch-'))
  await mkdir(join(root, 'policy'), { recursive: true })
  await writeFile(join(root, 'policy', 'cmp.mjs'), SCRIPT, 'utf8')
  await writeFile(join(root, 'policy', 'mode.json'), JSON.stringify({ mode }), 'utf8')
  return root
}

const baseContract = (batch = true) => ({
  fields: [
    { name: 'size', allowEmpty: true },
    { name: 'note', allowEmpty: true },
  ],
  records: { kind: 'list', values: ['R1', 'R2', 'R3'] },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  evidence: { required: false },
  ...(batch
    ? { adjudication: { compare: { command: 'node', args: ['policy/cmp.mjs'], batch: true } } }
    : { adjudication: { compare: { command: 'node', args: ['policy/cmp.mjs'] } } }),
})

const submissions = (record) => [
  { channel: 'text', status: 'valid', values: { size: '1.2cm', note: `n-${record}` }, evidence: {} },
  { channel: 'vision', status: 'valid', values: { size: '12mm', note: `n-${record}` }, evidence: {} },
]

const byRecord = new Map(['R1', 'R2', 'R3'].map((r) => [r, submissions(r)]))

async function callsOf(root) {
  const text = await readFile(join(root, 'policy', 'calls.log'), 'utf8')
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('契约校验：batch 只允许在 compare/select 的命令策略上', () => {
  const ok = validateContract(baseContract(true))
  assert.equal(ok.ok ?? ok.errors?.length === 0, true)
  assert.equal(validateContract(baseContract(true)).errors.length, 0)

  const builtinBatch = baseContract(true)
  builtinBatch.adjudication.compare = { builtin: 'exact', batch: true }
  assert.match(validateContract(builtinBatch).errors.join('\n'), /batch 只能与 command 一起使用/)

  const selectBatch = baseContract(true)
  selectBatch.adjudication.compare = { command: 'node', args: ['x.mjs'] }
  selectBatch.adjudication.select = { command: 'node', args: ['y.mjs'], batch: true }
  assert.equal(validateContract(selectBatch).errors.length, 0)

  const selectBuiltinBatch = baseContract(true)
  selectBuiltinBatch.adjudication.select = { builtin: 'first-valid', batch: true }
  assert.match(validateContract(selectBuiltinBatch).errors.join('\n'), /batch 只能与 command 一起使用/)

  const notBool = baseContract(true)
  notBool.adjudication.compare.batch = 'yes'
  assert.match(validateContract(notBool).errors.join('\n'), /batch 必须是布尔值/)
})

test('批量策略：一次命令判全部格', async () => {
  const root = await makeRoot()
  const decisions = adjudicate({ contract: baseContract(true), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root })
  assert.equal(decisions.length, 6)
  assert.ok(decisions.every((d) => d.status === 'accepted'))
  const calls = await callsOf(root)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'compare-batch')
  assert.equal(calls[0].cells, 6)
})

test('批量与逐格结果一致（golden）', async () => {
  const rootA = await makeRoot()
  const rootB = await makeRoot()
  const batch = adjudicate({ contract: baseContract(true), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root: rootA })
  const single = adjudicate({ contract: baseContract(false), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root: rootB })
  const shape = (d) => ({ record: d.record, field: d.field, status: d.status, value: d.value, adopted: d.adopted, synthesized: d.synthesized })
  assert.deepEqual(batch.map(shape), single.map(shape))
  assert.equal((await callsOf(rootB)).length, 6)
})

test('批量策略缺少结果 → 该格进待裁定（adjudicator_error）', async () => {
  const root = await makeRoot('missing')
  const decisions = adjudicate({ contract: baseContract(true), recordIds: ['R1', 'R2', 'R3'], submissionsByRecord: byRecord, root })
  const pending = decisions.filter((d) => d.status === 'pending')
  assert.equal(pending.length, 1)
  assert.ok(pending.every((d) => d.reason === 'adjudicator_error'))
  assert.match(pending[0].detail, /批量策略缺少结果/)
  assert.equal(decisions.filter((d) => d.status === 'accepted').length, 5)
})

test('批量策略返回重复格 → 整批拒绝', async () => {
  const root = await makeRoot('duplicate')
  assert.throws(
    () => adjudicate({ contract: baseContract(true), recordIds: ['R1'], submissionsByRecord: byRecord, root }),
    /重复的格/,
  )
})

test('批量策略退出码非零 → 全部格进待裁定', async () => {
  const root = await makeRoot()
  const contract = baseContract(true)
  contract.adjudication.compare.args = ['policy/nope.mjs']
  const decisions = adjudicate({ contract, recordIds: ['R1'], submissionsByRecord: byRecord, root })
  assert.ok(decisions.every((d) => d.status === 'pending' && d.reason === 'adjudicator_error'))
  assert.match(decisions[0].detail, /退出码|无法执行/)
})
