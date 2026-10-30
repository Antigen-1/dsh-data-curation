// The host requires every tool's `output.render` to return a content-block
// ARRAY. Returning a bare block made the harness call `.some` on an object and
// fail the whole tool call with "content.some is not a function" — even though
// the operation itself had already succeeded.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTools } from '../lib/tools.js'

async function collectTools() {
  const defs = []
  const ctx = { tools: { register: (definition) => defs.push(definition) } }
  await registerTools(ctx, { stateDir: '.curation' })
  return defs
}

/** Every content-block array the host would accept for this tool. */
function blocksOf(def, value) {
  const blocks = def.output.render({}, value)
  assert.ok(Array.isArray(blocks), `${def.name}: render 必须返回数组`)
  assert.ok(blocks.length > 0, `${def.name}: render 结果不能为空`)
  for (const block of blocks) {
    assert.equal(block.type, 'text', `${def.name}: 必须是 text block`)
    assert.equal(typeof block.text, 'string', `${def.name}: text 必须是字符串`)
  }
  return blocks
}

test('每个工具的失败结果都被渲染成 content block 数组', async () => {
  const defs = await collectTools()
  assert.equal(defs.length, 13)
  for (const def of defs) {
    const text = blocksOf(def, { ok: false, error: 'boom' }).map((b) => b.text).join('\n')
    assert.match(text, /boom/, `${def.name}: 失败原因要显示出来`)
  }
})

test('curation_init 的成功渲染包含基线信息', async () => {
  const defs = await collectTools()
  const init = defs.find((d) => d.name === 'curation_init')
  const text = blocksOf(init, {
    ok: true,
    files: 2,
    sha256: 'abc123',
    sources: ['raw'],
    workspace: '/tmp/project/.curation/project.sqlite',
  }).map((b) => b.text).join('\n')
  assert.match(text, /2 个源文件/)
  assert.match(text, /abc123/)
  assert.match(text, /project\.sqlite/)
})

test('curation_submit 的成功渲染说明落库位置', async () => {
  const defs = await collectTools()
  const submit = defs.find((d) => d.name === 'curation_submit')
  const text = blocksOf(submit, {
    ok: true,
    channel: 'text',
    batch: 'B001',
    records: 3,
    values: 9,
    storedIn: '.curation/project.sqlite',
  }).map((b) => b.text).join('\n')
  assert.match(text, /text/)
  assert.match(text, /B001/)
  assert.match(text, /3/)
})
