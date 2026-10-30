import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeFor, doInit, doSubmit, loadGates } from '../lib/core.js'
import { doPinCompat as doContract } from './_pin.js'
import { contractHash, validateContract } from '../lib/contract.js'
import { openDb, ensureStateSchema, STATE_SCHEMA_VERSION } from '../lib/db.js'
import { resolveRecordIds } from '../lib/delivery.js'
import { buildManifest, verifyManifest } from '../lib/manifest.js'

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-fix-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  return root
}

const listContract = (values = ['CASE-0001']) => ({
  fields: [{ name: 'note', allowEmpty: true }],
  records: { kind: 'list', values },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
})

test('CSV 记录源能解析（S1：此前少传表头直接 TypeError）', async () => {
  const root = await makeRoot()
  await writeFile(join(root, 'raw', 'keys.csv'), 'record_id,note\nCASE-0001,a\nCASE-0002,b\n', 'utf8')
  const contract = { ...listContract(), records: { kind: 'file', path: 'raw/keys.csv', key: 'record_id' } }
  const ids = await resolveRecordIds(root, contract)
  assert.deepEqual(ids, ['CASE-0001', 'CASE-0002'])
  await rm(root, { recursive: true, force: true })
})

test('CSV 记录源缺键列时报可读错误', async () => {
  const root = await makeRoot()
  await writeFile(join(root, 'raw', 'keys.csv'), 'id,note\n1,a\n', 'utf8')
  const contract = { ...listContract(), records: { kind: 'file', path: 'raw/keys.csv', key: 'record_id' } }
  await assert.rejects(() => resolveRecordIds(root, contract), /记录源缺少键列：record_id/)
  await rm(root, { recursive: true, force: true })
})

test('JSONL 记录源解析失败带行号（S6）', async () => {
  const root = await makeRoot()
  await writeFile(join(root, 'raw', 'keys.jsonl'), '{"record_id":"A"}\nnot-json\n', 'utf8')
  const contract = { ...listContract(), records: { kind: 'file', path: 'raw/keys.jsonl', key: 'record_id' } }
  await assert.rejects(() => resolveRecordIds(root, contract), /记录源第 2 行无法解析/)
  await rm(root, { recursive: true, force: true })
})

test('sources 为 "." 时工作区不进基线（S2：此前一写库就判源漂移）', async () => {
  const root = await makeRoot()
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001\n', 'utf8')
  const init = await doInit({ cwd: root, sources: ['.'] })
  assert.equal(init.ok, true, init.error)
  assert.deepEqual(init.excluded, ['.curation'])
  assert.match(init.warnings.join('；'), /工作区目录/)
  const contract = await doContract({ cwd: root, contract: listContract() })
  assert.equal(contract.ok, true, contract.error)
  const submit = await doSubmit({
    cwd: root,
    channel: 'text',
    batch: 'B001',
    records: [{ record_id: 'CASE-0001', values: { note: 'x' } }],
  })
  assert.equal(submit.ok, true, submit.error)
  const gates = await loadGates(storeFor(root, '.curation'))
  assert.equal(gates.problems.join('；').includes('源基线漂移'), false, gates.problems.join('；'))
  // 工作区文件本身不在清单里
  const manifest = JSON.parse(await readFile(join(root, '.curation', 'manifest.json'), 'utf8'))
  assert.equal(manifest.entries.some((e) => e.path.startsWith('.curation/')), false)
  await rm(root, { recursive: true, force: true })
})

test('契约里的显式 undefined 不改变哈希（S3）', () => {
  const a = validateContract({ ...listContract(), gates: { minAcceptedRatio: undefined } })
  assert.equal(a.ok, true, a.errors?.join('；'))
  const stored = JSON.parse(JSON.stringify(a.contract))
  assert.equal(contractHash(a.contract), contractHash(stored))
  // 冻结后读回来的哈希与封印一致，而不是误报"契约被手工改动"
  assert.equal(Object.prototype.hasOwnProperty.call(a.contract.gates, 'minAcceptedRatio'), false)
})

test('工作区 schema 版本门：旧库与更新库都拒绝打开（S4）', async () => {
  const root = await makeRoot()
  const dbPath = join(root, 'ws.sqlite')
  const fresh = openDb(dbPath)
  ensureStateSchema(fresh)
  assert.equal(fresh.prepare('PRAGMA user_version').get().user_version, STATE_SCHEMA_VERSION)
  fresh.close()

  const reopen = openDb(dbPath)
  ensureStateSchema(reopen) // 同版本可以重复打开
  reopen.close()

  const older = openDb(dbPath)
  older.exec('PRAGMA user_version = 1')
  older.close()
  assert.throws(() => ensureStateSchema(openDb(dbPath)), /工作区由旧版本创建/)

  const newer = openDb(dbPath)
  newer.exec('PRAGMA user_version = 99')
  newer.close()
  assert.throws(() => ensureStateSchema(openDb(dbPath)), /更新版本的 dsh-data-curation/)
  await rm(root, { recursive: true, force: true })
})

test('同一批里的重复记录键被整批拒绝（S5）', async () => {
  const root = await makeRoot()
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001\n', 'utf8')
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  assert.equal((await doContract({ cwd: root, contract: listContract() })).ok, true)
  const dup = await doSubmit({
    cwd: root,
    channel: 'text',
    batch: 'B001',
    records: [
      { record_id: 'CASE-0001', values: { note: 'a' } },
      { record_id: 'CASE-0001', values: { note: 'b' } },
    ],
  })
  assert.equal(dup.ok, false)
  assert.match(dup.error, /批次内重复记录：CASE-0001/)
  await rm(root, { recursive: true, force: true })
})

test('基线 fast path：size+mtime 未变则复用哈希，verify 全量仍能发现内容漂移', async () => {
  const root = await makeRoot()
  const file = join(root, 'raw', 'doc.txt')
  const stamp = 1700000000 // whole second: mtimeMs survives the round trip exactly
  await writeFile(file, 'AAAA', 'utf8')
  await utimes(file, stamp, stamp)
  const manifest = await buildManifest(root, ['raw'])

  // 同长度内容替换 + 把 mtime 改回去：fast path 看不见，全量校验看得见
  await writeFile(file, 'BBBB', 'utf8')
  await utimes(file, stamp, stamp)

  const fast = await verifyManifest(root, manifest, { reuse: manifest })
  assert.equal(fast.ok, true, 'fast path 按设计只信 size+mtime')

  const full = await verifyManifest(root, manifest, { reuse: null })
  assert.equal(full.ok, false)
  assert.deepEqual(full.changed, ['raw/doc.txt'])
  await rm(root, { recursive: true, force: true })
})
