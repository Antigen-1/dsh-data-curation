import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { loadSchemeRules } from '../lib/rules/index.js'

const loadTemplate = async (name) => {
  const source = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8')
  return loadSchemeRules(source)
}

test('decision-rules.example.scm 可加载并保留 decision 协议', async () => {
  const loaded = await loadTemplate('decision-rules.example.scm')
  const votes = [
    { channel: 'text', status: 'valid', raw: '42', evidence: { page: 1, quote: '42' } },
    { channel: 'vision', status: 'valid', raw: '42', evidence: { page: 1, quote: '42' } },
  ]
  assert.deepEqual(await loaded.registry.call('scheme.example.decision', [{ votes }]), {
    accepted: true,
    value: '42',
    adopted: ['text'],
    reason: 'scheme.example.two-channel',
  })
  assert.equal(loaded.pinRules.decision.id, 'scheme.example.decision')
})

test('verify-rules.example.scm 可加载并返回结构化 check', async () => {
  const loaded = await loadTemplate('verify-rules.example.scm')
  assert.deepEqual(await loaded.registry.call('scheme.example.verify', [{}]), {
    checks: [{ name: 'scheme_example_audit', status: 'pass', detail: 'Scheme verify example executed' }],
  })
  assert.equal(loaded.pinRules.verify.id, 'scheme.example.verify')
})

test('register-rules.example.scm 用 named let 生成独立闭包快照', async () => {
  const loaded = await loadTemplate('register-rules.example.scm')
  assert.deepEqual(loaded.registry.ids(), ['scheme.generated.0', 'scheme.generated.1', 'scheme.generated.2'])
  for (let i = 0; i < 3; i++) {
    assert.equal(await loaded.registry.call(`scheme.generated.${i}`, [i]), true)
    assert.equal(await loaded.registry.call(`scheme.generated.${i}`, [i + 1]), false)
  }
})
