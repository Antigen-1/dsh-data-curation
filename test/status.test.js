import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doInit, doStatus } from '../lib/core.js'
import { statusLines } from '../lib/format.js'
import { registerCommands } from '../lib/commands.js'
import { registerTools } from '../lib/tools.js'

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-curation-status-'))
  await mkdir(join(root, 'raw'), { recursive: true })
  await writeFile(join(root, 'raw', 'doc.txt'), 'CASE-0001\n', 'utf8')
  return root
}

test('有基线但未签 pin 时 status 仍是成功结果', async () => {
  const root = await makeRoot()
  try {
    assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
    const status = await doStatus({ cwd: root })
    assert.equal(status.ok, true)
    assert.equal(status.pin, null)
    assert.ok(status.manifest)
    const text = statusLines(status).join('\n')
    assert.match(text, /pin：未签署/)
    assert.doesNotMatch(text, /^✗/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/curation 在无 pin 时展示状态而不是误报尚未建立基线', async () => {
  const root = await makeRoot()
  const handlers = new Map()
  const ctx = { commands: { register: (definition) => handlers.set(definition.name, definition) } }
  try {
    await doInit({ cwd: root, sources: ['raw'] })
    await registerCommands(ctx, { stateDir: '.curation' })
    const result = await handlers.get('curation').handler({ agent: { session: { header: { cwd: root } } } })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /当前状态：/)
    assert.match(result.text, /源基线：1 个文件/)
    assert.match(result.text, /pin：未签署/)
    assert.doesNotMatch(result.text, /尚未建立基线/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('curation_status 把真实 SQLite 读取异常转成可读 tool error', async () => {
  const root = await makeRoot()
  try {
    assert.equal((await doInit({ cwd: root, sources: ['raw'] })).ok, true)
    // Corrupt the real workspace after init has closed it. The next status call
    // must throw from SQLite while reading; no execute method or result is mocked.
    await writeFile(join(root, '.curation', 'project.sqlite'), 'not a sqlite database\n', 'utf8')

    const defs = []
    await registerTools({ tools: { register: (definition) => defs.push(definition) } }, { stateDir: '.curation' })
    const status = defs.find((definition) => definition.name === 'curation_status')
    const result = await status.execute({ cwd: root })
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    assert.match(result.error, /file is not a database/i)

    const blocks = status.output.render({ cwd: root }, result)
    assert.ok(Array.isArray(blocks))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /^✗ /)
    assert.ok(blocks[0].text.includes(result.error), '渲染后的 tool error 必须保留真实读取异常')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
