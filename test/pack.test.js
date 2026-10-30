import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doApply, doCompare, doExporter, doInit, doPack, doSubmit } from '../lib/core.js'
import { doPinCompat as doContract } from './_pin.js'
import { tokenizeCommand } from '../lib/pack.js'

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-pack-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await mkdir(join(root, 'tools'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001 位于A区\n', 'utf8')
  await writeFile(join(root, 'tools', 'check.mjs'), 'process.exit(0)\n', 'utf8')
  await writeFile(join(root, 'tools', 'export-x.mjs'), "process.stdout.write('x')\n", 'utf8')
  return root
}

const contractOf = () => ({
  fields: [
    { name: 'location', allowEmpty: false },
    { name: 'measured_value', type: 'number', allowEmpty: true },
  ],
  records: { kind: 'list', values: ['CASE-0001'] },
  delivery: { table: 'summary', key: 'record_id' },
  channels: [{ name: 'text' }, { name: 'vision' }],
  gates: { minAcceptedRatio: 1, verifyCmd: 'node tools/check.mjs' },
})

async function seed(root) {
  assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
  assert.equal((await doContract({ cwd: root, contract: contractOf() })).ok, true)
  for (const [channel, value] of [['text', '1.5cm'], ['vision', '15mm']]) {
    const r = await doSubmit({
      cwd: root,
      channel,
      batch: 'B001',
      records: [{
        record_id: 'CASE-0001',
        status: 'valid',
        values: { location: 'A区', measured_value: value },
        evidence: { location: { page: 1 }, measured_value: { page: 1 } },
      }],
    })
    assert.equal(r.ok, true, r.error)
  }
  assert.equal((await doCompare({ cwd: root })).ok, true)
  assert.equal((await doApply({ cwd: root })).ok, true)
}

/** Entry count straight from the ZIP end-of-central-directory record. */
function zipEntryCount(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10)
  }
  return -1
}

test('pack：工作区快照 + 契约 + 导出器 + 被引用的外部脚本', async () => {
  const root = await makeProject()
  await seed(root)
  const added = await doExporter({ cwd: root, action: 'add', name: 'xfmt', command: 'node tools/export-x.mjs' })
  assert.equal(added.ok, true)

  const pack = await doPack({ cwd: root, label: '验收存档' })
  assert.equal(pack.ok, true, JSON.stringify(pack.warnings))
  assert.ok(pack.path.endsWith('.zip'))
  assert.deepEqual(pack.warnings, [])

  const names = pack.files.map((f) => f.name).sort()
  assert.deepEqual(names, [
    'exporters.json',
    'manifest.json',
    'pin.json',
    'project.sqlite',
    'referenced/tools/check.mjs',
    'referenced/tools/export-x.mjs',
  ])
  for (const f of pack.files) assert.ok(f.size > 0, `${f.name} 为空`)

  const buf = await readFile(pack.path)
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004')
  assert.equal(zipEntryCount(buf), pack.files.length + 1) // + pack.json
  const raw = buf.toString('latin1')
  for (const name of ['pack.json', 'project.sqlite', 'pin.json', 'exporters.json']) {
    assert.ok(raw.includes(name), `zip 中缺少 ${name}`)
  }
  assert.equal(pack.pinHash.length, 64)
  assert.equal(pack.sourceManifestSha.length, 64)
})

test('pack：被引用的脚本不存在时只警告，不影响打包', async () => {
  const root = await makeProject()
  await seed(root)
  await doExporter({ cwd: root, action: 'add', name: 'ghost', command: 'node tools/missing.mjs' })
  const pack = await doPack({ cwd: root })
  assert.equal(pack.ok, true)
  assert.ok(pack.warnings.some((w) => /引用文件不可读/.test(w)))
  assert.ok(!pack.files.some((f) => f.name.includes('missing.mjs')))
})

test('pack：被引用的脚本是符号链接时跳过（不把外部内容打进包）', async () => {
  const root = await makeProject()
  await seed(root)
  const outside = await mkdtemp(join(tmpdir(), 'dsh-curation-outside-'))
  const secret = join(outside, 'secret.sh')
  await writeFile(secret, 'echo top-secret\n', 'utf8')
  await symlink(secret, join(root, 'tools', 'linked.mjs'))
  const add = await doExporter({ cwd: root, action: 'add', name: 'linked', command: 'node tools/linked.mjs' })
  assert.equal(add.ok, true, add.error)

  const pack = await doPack({ cwd: root })
  assert.equal(pack.ok, true, pack.error)
  assert.equal(pack.files.some((f) => f.name.includes('linked.mjs')), false)
  assert.match(pack.warnings.join('；'), /符号链接/)
  const buf = await readFile(pack.path)
  assert.equal(buf.includes(Buffer.from('top-secret')), false)
})

test('tokenizeCommand 处理引号与空白', () => {
  assert.deepEqual(tokenizeCommand('node tools/x.mjs --flag "a b"'), ['node', 'tools/x.mjs', '--flag', 'a b'])
  assert.deepEqual(tokenizeCommand("sh -c 'node x.mjs'"), ['sh', '-c', 'node x.mjs'])
  assert.deepEqual(tokenizeCommand('   '), [])
})
