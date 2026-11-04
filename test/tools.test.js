// The host requires every tool's `output.render` to return a content-block
// ARRAY. These tests execute the real tool functions against temporary projects
// and render the values returned by those executions; no success output is
// replaced with a snapshot or a hand-written tool result.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doApply, doCompare, doInit, doNote, doPin, doSubmit } from '../lib/core.js'
import { doPinDraft, doRecordsImport } from '../lib/intake.js'
import { QUERY_KINDS } from '../lib/query.js'
import { normalizeToolOutput, registerTools } from '../lib/tools.js'

const progressEvents = []
globalThis.__curationToolsTestProgressEvents = progressEvents

// The repository deliberately has no host packages installed. Shim only the
// host's session-record transport; curation_progress still runs its real input
// validation, appendProgressPatch, execute method, and output renderer.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== '@deepseek-ai/dsh-session') return nextResolve(specifier, context)
    const source = `
      export function appendPluginRecord(session, type, data) {
        globalThis.__curationToolsTestProgressEvents.push({ session, type, data })
        return globalThis.__curationToolsTestProgressEvents.length
      }
    `
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  },
})

async function collectTools() {
  const defs = []
  const ctx = { tools: { register: (definition) => defs.push(definition) } }
  await registerTools(ctx, { stateDir: '.curation' })
  return defs
}

/** Assert the exact content-block array contract accepted by the host. */
function blocksOf(def, value, args = {}) {
  const blocks = def.output.render(args, value)
  assert.ok(Array.isArray(blocks), `${def.name}: render 必须返回数组`)
  assert.ok(blocks.length > 0, `${def.name}: render 结果不能为空`)
  for (const block of blocks) {
    assert.equal(block.type, 'text', `${def.name}: 必须是 text block`)
    assert.equal(typeof block.text, 'string', `${def.name}: text 必须是字符串`)
    assert.ok(block.text.length > 0, `${def.name}: text 不能为空`)
  }
  assert.doesNotThrow(() => JSON.stringify(blocks), `${def.name}: 输出必须可序列化`)
  return blocks
}

async function makeProject(records) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-tools-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await mkdir(join(root, 'input'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), `${records.join('\n')}\nA区 1.5cm\n`, 'utf8')
  const csv = ['record_id,location,measured_value', ...records.map((record) => `${record},A区,1.5cm`)].join('\n')
  await writeFile(join(root, 'input', 'records.csv'), `${csv}\n`, 'utf8')
  return root
}

const submission = (record, measuredValue = '1.5cm') => ({
  record_id: record,
  status: 'valid',
  values: { location: 'A区', measured_value: measuredValue },
  evidence: {
    location: { page: 1, quote: 'A区' },
    measured_value: { page: 1, quote: measuredValue },
  },
})

test('每个工具的失败结果都被渲染成非空 content block 数组', async () => {
  const defs = await collectTools()
  assert.equal(defs.length, 19)
  for (const def of defs) {
    const text = blocksOf(def, { ok: false, error: 'boom' }).map((b) => b.text).join('\n')
    assert.match(text, /boom/, `${def.name}: 失败原因要显示出来`)
  }
})

test('全部公开 curation_* 工具的真实成功路径都可执行并渲染', async (t) => {
  const defs = await collectTools()
  const byName = new Map(defs.map((def) => [def.name, def]))
  const root = await makeProject(['CASE-0001'])
  const covered = new Set()
  let recordsPath
  let draftPath
  let deliveryPath

  const run = async (name, args = {}, exec = {}) => {
    const def = byName.get(name)
    assert.ok(def, `缺少公开工具 ${name}`)
    const toolArgs = name === 'curation_progress' ? args : { cwd: root, ...args }
    const value = await def.execute(toolArgs, exec)
    assert.equal(value.ok, true, `${name}: ${value.error ?? JSON.stringify(value.errors ?? value.checks ?? value)}`)
    const blocks = blocksOf(def, value, toolArgs)
    covered.add(name)
    return { value, blocks }
  }

  try {
    await t.test('curation_init', async () => {
      const { value } = await run('curation_init', { sources: ['raw'], tables: ['summary'] })
      assert.equal(value.files, 1)
    })
    await t.test('curation_records_import', async () => {
      const { value } = await run('curation_records_import', { path: 'input/records.csv', table: 'summary' })
      assert.equal(value.count, 1)
      recordsPath = value.path
    })
    await t.test('curation_pin_draft', async () => {
      const { value } = await run('curation_pin_draft', {
        recordsPath, table: 'summary', channels: ['text', 'vision'],
      })
      assert.equal(value.records, 1)
      draftPath = value.draftPath
    })
    await t.test('curation_identity', async () => {
      const { value } = await run('curation_identity', {
        path: 'input/records.csv', table: 'identity_smoke',
        rename: { 'CASE-0001': 'CASE-ID-1' }, fileMap: { 'CASE-ID-1': 'raw/doc.txt' },
      })
      assert.equal(value.count, 1)
      assert.equal(value.renamed, 1)
    })
    await t.test('curation_pin', async () => {
      const { value } = await run('curation_pin', { draftPath })
      assert.equal(value.version, 5)
      assert.equal(value.records, 1)
    })
    await t.test('curation_submit', async () => {
      const { value } = await run('curation_submit', {
        channel: 'text', batch: 'B001', records: [submission('CASE-0001')],
      })
      assert.equal(value.records, 1)
    })
    await t.test('curation_job', async () => {
      await writeFile(
        join(root, 'input', 'vision.jsonl'),
        `${JSON.stringify(submission('CASE-0001'))}\n`,
        'utf8',
      )
      const { value } = await run('curation_job', {
        action: 'start', from: 'input/vision.jsonl', channel: 'vision', batch: 'BJ001', chunkSize: 1,
      })
      assert.equal(value.job.status, 'completed')
      assert.equal(value.job.submitted, 1)
    })
    await t.test('curation_note', async () => {
      const { value } = await run('curation_note', { text: '真实工具 smoke 事件' })
      assert.equal(value.scope, 'project')
    })
    await t.test('curation_compare', async () => {
      const { value } = await run('curation_compare', { scope: 'all', full: true })
      assert.ok(value.accepted > 0)
      assert.equal(value.pendingTotal ?? value.pending, 0)
    })
    await t.test('curation_apply', async () => {
      const { value } = await run('curation_apply', { keepBackups: 1 })
      assert.ok(value.applied > 0)
    })
    await t.test('curation_verify', async () => {
      const { value } = await run('curation_verify')
      assert.equal(value.status, 'PASS', JSON.stringify(value.checks))
    })
    await t.test('curation_export', async () => {
      const { value } = await run('curation_export', { format: 'csv' })
      assert.equal(value.rows, 1)
      assert.match(await readFile(value.path, 'utf8'), /CASE-0001/)
    })
    await t.test('curation_exporter', async () => {
      const { value } = await run('curation_exporter', { action: 'list' })
      assert.ok(value.builtins.length > 0)
    })
    await t.test('curation_pack', async () => {
      const { value } = await run('curation_pack', { label: 'tool-smoke' })
      assert.ok(value.files.length > 0)
      assert.ok(value.bytes > 0)
    })
    await t.test('curation_status', async () => {
      const { value } = await run('curation_status')
      assert.ok(value.manifest)
      assert.ok(value.pin)
    })
    await t.test('curation_query', async () => {
      const { value } = await run('curation_query', { what: 'counts', format: 'json' })
      assert.ok(value.data.decisions.total > 0)
    })
    await t.test('curation_delivery_plan', async () => {
      const { value } = await run('curation_delivery_plan', { action: 'build' })
      assert.ok(value.files.length > 0)
      deliveryPath = value.path
    })
    await t.test('curation_verify_delivery', async () => {
      const { value } = await run('curation_verify_delivery', { path: deliveryPath })
      assert.equal(value.status, 'PASS', JSON.stringify(value.checks))
    })
    await t.test('curation_progress', async () => {
      const before = progressEvents.length
      const session = { id: 'tool-smoke-session' }
      const { value } = await run(
        'curation_progress',
        { upsert: [{ id: 'smoke', label: '工具测试', value: 1, total: 1, status: 'done' }] },
        { agent: { session } },
      )
      assert.deepEqual(value.upsert, ['smoke'])
      assert.equal(progressEvents.length, before + 1)
      assert.equal(progressEvents.at(-1).session, session)
    })

    assert.deepEqual([...covered].sort(), [...byName.keys()].sort(), '每个公开工具都必须有真实成功 fixture')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function assertNonEmptyQueryData(what, data) {
  if (['pending', 'cells', 'submissions', 'runs', 'events', 'schema', 'coverage'].includes(what)) {
    assert.ok(Array.isArray(data), `${what}: data 必须是数组`)
    assert.ok(data.length > 0, `${what}: 真实查询数据不能为空`)
    return
  }
  if (what === 'votes') {
    assert.equal(data.found, true)
    assert.ok(data.votes.length >= 2)
    return
  }
  if (what === 'counts') {
    assert.ok(data.decisions.total > 0)
    assert.ok(data.submissions.length > 0)
    assert.ok(data.runs.total > 0)
    return
  }
  if (what === 'meta') {
    assert.ok(data.project)
    assert.ok(data.pin)
    assert.ok(data.tables.length > 0)
    return
  }
  assert.fail(`未声明非空断言的查询类型：${what}`)
}

test('curation_query 的 10 种真实非空结果 × table/json 都符合工具 schema', async (t) => {
  const defs = await collectTools()
  const query = defs.find((def) => def.name === 'curation_query')
  assert.deepEqual([...query.parameters.what.enum].sort(), [...QUERY_KINDS].sort())

  const root = await makeProject(['CASE-0001', 'CASE-0002'])
  try {
    assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
    const imported = await doRecordsImport({ cwd: root, path: 'input/records.csv', table: 'summary' })
    assert.equal(imported.ok, true, imported.error)
    const draft = await doPinDraft({ cwd: root, recordsPath: imported.path, table: 'summary' })
    assert.equal(draft.ok, true, draft.error)
    assert.equal((await doPin({ cwd: root, draftPath: draft.draftPath })).ok, true)

    for (const channel of ['text', 'vision']) {
      const first = await doSubmit({ cwd: root, channel, batch: `B-${channel}`, records: [submission('CASE-0001')] })
      assert.equal(first.ok, true, first.error)
    }
    // A second record with one channel creates genuine pending cells. Applying
    // the accepted cells also gives schema a real curated table without making
    // the query fixture an all-empty or all-success synthetic object.
    const second = await doSubmit({ cwd: root, channel: 'text', batch: 'B-pending', records: [submission('CASE-0002')] })
    assert.equal(second.ok, true, second.error)
    const compared = await doCompare({ cwd: root, scope: 'all', full: true })
    assert.equal(compared.ok, true, compared.error)
    assert.ok(compared.accepted > 0)
    assert.ok((compared.pendingTotal ?? compared.pending) > 0)
    assert.equal((await doApply({ cwd: root })).ok, true)
    assert.equal((await doNote({ cwd: root, text: 'query 非空矩阵事件' })).ok, true)

    for (const what of QUERY_KINDS) {
      for (const format of ['table', 'json']) {
        await t.test(`${what}/${format}`, async () => {
          const args = {
            cwd: root,
            what,
            format,
            limit: 50,
            ...(what === 'votes' ? { record: 'CASE-0001', field: 'location' } : {}),
          }
          const value = await query.execute(args)
          assert.equal(value.ok, true, value.error)
          assert.equal(value.what, what)
          assertNonEmptyQueryData(what, value.data)
          const blocks = blocksOf(query, value, args)
          assert.equal(blocks.length, 1)
          if (format === 'json') assert.deepEqual(JSON.parse(blocks[0].text), value.data)
        })
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizeToolOutput 只接受白名单中的成功输出形状', async (t) => {
  const block = { type: 'text', text: 'a' }
  const accepted = [
    ['string', 'a', [{ type: 'text', text: 'a' }]],
    ['string array', ['a', 'b'], [{ type: 'text', text: 'a\nb' }]],
    ['single text block', block, [block]],
    ['text block array', [block, { type: 'text', text: 'b' }], [block, { type: 'text', text: 'b' }]],
  ]
  for (const [name, input, expected] of accepted) {
    await t.test(`accept ${name}`, () => assert.deepEqual(normalizeToolOutput(input), expected))
  }
})

test('normalizeToolOutput 拒绝白名单外或混合的输出形状', async (t) => {
  const rejected = [
    ['undefined', undefined],
    ['null', null],
    ['number', 1],
    ['plain object', { text: 'a' }],
    ['empty array', []],
    ['mixed string and block', ['a', { type: 'text', text: 'b' }]],
    ['null item', [null]],
    ['wrong block type', [{ type: 'image', text: 'a' }]],
    ['missing text', [{ type: 'text' }]],
    ['non-string text', [{ type: 'text', text: 42 }]],
  ]
  for (const [name, input] of rejected) {
    await t.test(`reject ${name}`, () => assert.throws(
      () => normalizeToolOutput(input, { tool: 'curation_test', path: '$.output.render' }),
      (error) => {
        assert.equal(error.code, 'TOOL_OUTPUT_INVALID')
        assert.equal(error.tool, 'curation_test')
        assert.equal(error.path, '$.output.render')
        assert.match(error.message, /curation_test/)
        assert.match(error.message, /\$\.output\.render/)
        return true
      },
    ))
  }
})
