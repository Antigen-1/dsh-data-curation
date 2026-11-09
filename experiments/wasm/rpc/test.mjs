import assert from 'node:assert/strict'
import { startRpcServer } from './service.mjs'

const service = await startRpcServer()

async function rpc (engine, request) {
  const response = await fetch(`${service.url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine, request }),
  })
  return await response.json()
}

try {
  const health = await fetch(`${service.url}/health`).then((r) => r.json())
  assert.equal(health.ok, true)
  console.log('health', JSON.stringify(health))

  const chibi = await rpc('chibi', {
    id: 'c1', op: 'eval', source: '(lambda (x) (+ x 1))', args: [41],
  })
  assert.equal(chibi.ok, true)
  assert.equal(chibi.value, 42)
  console.log('chibi-eval', JSON.stringify(chibi))

  const chez = await rpc('chez', {
    id: 'z1', op: 'eval', source: '(lambda (x) (+ x 1))', args: [41],
  })
  assert.equal(chez.ok, true)
  assert.equal(chez.value, 42)
  console.log('chez-eval', JSON.stringify(chez))

  const loaded = await rpc('chibi', {
    id: 'c2',
    op: 'load-module',
    source: '(register-rule! "stored" "1" (lambda (x) x))',
    calls: [{ rule: 'stored', args: [7] }],
  })
  assert.equal(loaded.ok, true)
  assert.equal(loaded.calls[0].value, 7)
  console.log('chibi-load', JSON.stringify(loaded))

  const chezLoaded = await rpc('chez', {
    id: 'z2',
    op: 'load-module',
    source: '(register-rule! "stored" "1" (lambda (x) x))',
    calls: [{ rule: 'stored', args: [7] }],
  })
  assert.equal(chezLoaded.ok, true)
  assert.equal(chezLoaded.calls[0].value, 7)
  console.log('chez-load', JSON.stringify(chezLoaded))

  const stateless = await rpc('chibi', {
    id: 'c3',
    op: 'load-module',
    source: '',
    calls: [{ rule: 'stored', args: [8] }],
  })
  assert.equal(stateless.ok, true)
  assert.equal(stateless.calls[0].ok, false)
  assert.equal(stateless.calls[0].error.code, 'UNBOUND_RULE')
  console.log('chibi-new-process-state-lost', JSON.stringify(stateless))

  const timeout = await rpc('chibi', {
    id: 'c4',
    op: 'eval',
    source: '(let loop () (loop))',
    args: [],
    limits: { wallTimeoutMs: 150 },
  })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.error.code, 'TIMEOUT')
  console.log('chibi-timeout', JSON.stringify(timeout))

  const afterTimeout = await rpc('chibi', { id: 'c5', op: 'capabilities' })
  assert.equal(afterTimeout.ok, true)
  console.log('chibi-restart-after-timeout', JSON.stringify(afterTimeout))

  const parallel = await Promise.all([
    rpc('chibi', { id: 'p1', op: 'eval', source: '(lambda (x) (* x 2))', args: [21] }),
    rpc('chibi', { id: 'p2', op: 'eval', source: '(lambda (x) (* x 2))', args: [21] }),
  ])
  for (const result of parallel) {
    assert.equal(result.ok, true)
    assert.equal(result.value, 42)
  }
  console.log('chibi-parallel', JSON.stringify(parallel.map((r) => r.id)))

  console.log('RESULT PASS')
} finally {
  await service.close()
}
