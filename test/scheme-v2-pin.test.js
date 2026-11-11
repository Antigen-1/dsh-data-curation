import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadSchemeV2Pin, loadSchemeV2PinFile, SchemeV2Runtime } from '../lib/rules/index.js'
import { CvmClient } from '../lib/rules/scheme/v2/client.js'
import { CvmSupervisor } from '../lib/rules/scheme/v2/supervisor.js'
import { decodeSourceBase64, pinEngine, projectLibraryName, schemeString } from '../lib/rules/scheme/v2/pin-lib.js'
import { readPluginFiles } from '../lib/rules/scheme/v2/loader.js'

const pinPath = fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-a.json', import.meta.url))
const pluginPinPath = fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-plugin-a.json', import.meta.url))
const pluginProjectRoot = fileURLToPath(new URL('./fixtures/scheme-v2/project', import.meta.url))
const ffiMathUrl = new URL('./fixtures/scheme-v2/ffi/math.mjs', import.meta.url)

function ffiRequest (id, rid, target, args, vm) {
  if (vm) vm.currentRuleHash = 'rule'
  return `(request ${schemeString(id)} ffi-call ${schemeString(rid)} "ffi" "rule" ${schemeString(target)} (${args}) ${schemeString(vm.bridgeToken)})`
}

async function rehashRule (pin, source, ffi = []) {
  pin.rules[0].sourceBase64 = Buffer.from(source, 'utf8').toString('base64')
  pin.rules[0].signature = { inputs: [], output: 'number', variadic: false }
  pin.ffi = ffi
  const modulesDatum = `(${pin.modules.map((module) => {
    const moduleSource = decodeSourceBase64(module.sourceBase64)
    return `(${module.name} (${module.version.join(' ')}) ${schemeString(moduleSource)})`
  }).join(' ')})`
  const ffiDatum = `(${pin.ffi.map((entry) => `(${schemeString(JSON.stringify(entry))})`).join(' ')})`
  const vm = new CvmClient()
  try {
    const raw = await vm.dispatch(`(request "verify" pin-verify (rule ${schemeString('rule.example')} (1 0 0) ${schemeString(source)} ${modulesDatum} () ${ffiDatum} (signature () number #f)))`)
    const value = JSON.parse(raw).value
    for (const field of ['treeHash', 'bundleHash', 'pluginEnvironmentHash', 'ffiEnvironmentHash', 'ruleHash']) {
      pin.rules[0][field] = value[field]
    }
  } finally {
    await vm.close()
  }
  return pin
}

test('loadSchemeV2Pin verifies hashes without evaluating project libraries', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const loaded = await loadSchemeV2Pin(pin)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.loaded, false)
  assert.equal(loaded.metadataOnly, true)
  assert.equal(loaded.project, 'pin-v2-fixture-a')
  assert.equal(loaded.rules.length, 1)
  assert.equal(loaded.rules[0].id, 'rule.example')
  assert.deepEqual(loaded.modules.map((module) => module.name), ['(dsh lib base (1 0 0))', '(dsh lib math (1 0 0))'])
  assert.match(loaded.engine.engineArtifactHash, /^sha256:[0-9a-f]{64}$/)
})

test('loadSchemeV2Pin rejects a tampered expected hash without returning metadata', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.rules[0].treeHash = '0'.repeat(64)
  await assert.rejects(loadSchemeV2Pin(pin), /E-PIN-MISMATCH:treeHash/)
})

test('loadSchemeV2PinFile reads the pin from disk', async () => {
  const loaded = await loadSchemeV2PinFile(pinPath)
  assert.equal(loaded.loaded, false)
  assert.equal(loaded.rules.length, 1)
})

test('pinEngine rejects legacy or unbound FFI declarations', () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.ffi = ['math.add']
  assert.throws(() => pinEngine(pin), /E-PIN-FFI-BINDING/)
  pin.ffi = [{ id: 'math.add' }]
  assert.throws(() => pinEngine(pin), /E-PIN-FFI-BINDING/)
})

test('SchemeV2Runtime refuses host FFI when the pin declares none', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  await assert.rejects(
    SchemeV2Runtime.open(pin, { ffiModules: { math: ffiMathUrl } }),
    (error) => error.code === 'E-V2-FFI-UNDECLARED',
  )
})

test('CvmClient services a blocking FFI frame from an explicit host map', async () => {
  const vm = new CvmClient({
    ffiModules: { math: ffiMathUrl.href },
    ffiTimeoutMs: 500,
    ffiTargets: ['math.add', 'math.fail'],
  })
  await vm.preloadFfiModules()
  try {
    const raw = await vm.dispatch(ffiRequest('f1', 'r1', 'math.add', '2 3', vm))
    assert.deepEqual(JSON.parse(raw), { id: 'f1', ok: true, value: 5 })
    const failure = await vm.dispatch(ffiRequest('f2', 'r2', 'math.fail', '1 2', vm))
    assert.equal(JSON.parse(failure).error.code, 'E-FFI-HOST')
    const undeclared = await vm.dispatch(ffiRequest('f3', 'r3', 'math.undeclared', '1 2', vm))
    assert.equal(JSON.parse(undeclared).error.code, 'E-FFI-NOT-DECLARED')
  } finally {
    await vm.close()
  }
})

test('TLV preserves null and empty list across guest and host', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    "  (define (entry) (ffi-call \"math.echo\" 'dsh-null '())))",
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.echo',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, {
    ffiModules: { math: ffiMathUrl },
  })
  try {
    assert.deepEqual(await runtime.call('rule.example'), [null, []])
  } finally {
    await runtime.close()
  }
})

test('TLV preserves exact flonums across guest and host', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.echo" 2.0)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.echo',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, { ffiModules: { math: ffiMathUrl } })
  try {
    assert.deepEqual(await runtime.call('rule.example'), [2])
  } finally {
    await runtime.close()
  }
})

test('TLV preserves object values across guest and host', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    "  (define (entry) (ffi-call \"math.object\" (list (cons 'a 1)))))",
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.object',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, { ffiModules: { math: ffiMathUrl } })
  try {
    assert.deepEqual(await runtime.call('rule.example'), { a: 1 })
  } finally {
    await runtime.close()
  }
})

test('an out-of-safe-range exact integer is a rule error rather than a crashed VM', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.echo" (expt 2 60))))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.echo',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, { ffiModules: { math: ffiMathUrl } })
  try {
    await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-RULE-ERROR')
    await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-RULE-ERROR')
  } finally {
    await runtime.close()
  }
})

test('a verified rule imports (dsh ffi (6)) and calls an allowlisted host target', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.add" 2 3)))',
    '',
  ].join('\n')
  pin.rules[0].sourceBase64 = Buffer.from(source, 'utf8').toString('base64')
  pin.rules[0].signature = { inputs: [], output: 'number', variadic: false }
  pin.ffi = [{
    id: 'math.add',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }]

  const modulesDatum = `(${pin.modules.map((module) => {
    const moduleSource = decodeSourceBase64(module.sourceBase64)
    return `(${module.name} (${module.version.join(' ')}) ${schemeString(moduleSource)})`
  }).join(' ')})`
  const ffiDatum = `(${pin.ffi.map((entry) => `(${schemeString(JSON.stringify(entry))})`).join(' ')})`
  const vm = new CvmClient()
  try {
    const raw = await vm.dispatch(`(request "verify-ffi" pin-verify (rule ${schemeString('rule.example')} (1 0 0) ${schemeString(source)} ${modulesDatum} () ${ffiDatum} (signature () number #f)))`)
    const value = JSON.parse(raw).value
    for (const field of ['treeHash', 'bundleHash', 'pluginEnvironmentHash', 'ffiEnvironmentHash', 'ruleHash']) {
      pin.rules[0][field] = value[field]
    }
  } finally {
    await vm.close()
  }

  const runtime = await SchemeV2Runtime.open(pin, {
    ffiModules: { math: ffiMathUrl },
  })
  try {
    assert.equal(await runtime.call('rule.example'), 5)
  } finally {
    await runtime.close()
  }
})

test('a verified rule cannot call an FFI target outside its subject binding', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.fail" 1 2)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.add',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, {
    ffiModules: { math: ffiMathUrl },
  })
  try {
    await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-RULE-ERROR')
  } finally {
    await runtime.close()
  }
})

test('a verified rule maps a bound FFI provider failure to E-RULE-ERROR', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.fail" 1 2)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.fail',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, {
    ffiModules: { math: ffiMathUrl },
  })
  try {
    await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-RULE-ERROR')
  } finally {
    await runtime.close()
  }
})

test('SchemeV2Runtime rejects a missing ffiModules file at open', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.add" 2 3)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.add',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  await assert.rejects(
    SchemeV2Runtime.open(pin, {
      ffiModules: { math: new URL('./fixtures/scheme-v2/ffi/missing.mjs', import.meta.url) },
    }),
    (error) => error.code === 'E-FFI-MODULE',
  )
})

test('SchemeV2Runtime rejects ffiModules that miss a declared namespace', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.add" 2 3)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.add',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  await assert.rejects(
    SchemeV2Runtime.open(pin, { ffiModules: { other: ffiMathUrl } }),
    (error) => error.code === 'E-FFI-MODULE',
  )
})

test('a supervised runtime terminates a hanging FFI provider', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.never" 1 2)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.never',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    ffiModules: { math: ffiMathUrl },
    ffiTimeoutMs: 50,
  })
  try {
    await assert.rejects(
      runtime.call('rule.example'),
      (error) => ['E-FFI-TIMEOUT', 'E-TIMEOUT', 'E-VM-EXIT'].includes(error.code),
    )
    await runtime.restart()
    assert.equal(runtime.closed, false)
  } finally {
    await runtime.close()
  }
})

test('a verified rule cannot escape to (chezscheme) or read the bridge token', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (rnrs eval (6)))',
    '  (define (entry)',
    '    (eval (quote current-ffi-token)',
    '          ((eval (quote interaction-environment) (environment (quote (chezscheme))))))))',
    '',
  ].join('\n')
  await rehashRule(pin, source)
  const runtime = await SchemeV2Runtime.open(pin)
  try {
    await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-RULE-ERROR')
  } finally {
    await runtime.close()
  }
})

test('a verified rule cannot import (dsh ffi (6)) through safe eval', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (rnrs eval (6)))',
    "  (define (entry) (environment '(dsh ffi (6)))))",
    '',
  ].join('\n')
  await rehashRule(pin, source)
  const runtime = await SchemeV2Runtime.open(pin)
  try {
    await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-RULE-ERROR')
  } finally {
    await runtime.close()
  }
})

test('a verified rule cannot import (dsh ffi (6)) to forge another rule identity', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.add" 1 2)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.add',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, {
    ffiModules: { math: ffiMathUrl },
  })
  try {
    assert.equal(await runtime.call('rule.example'), 3)
  } finally {
    await runtime.close()
  }
})

test('SchemeV2Runtime rejects duplicate rule ids before starting a VM', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.rules.push(structuredClone(pin.rules[0]))
  await assert.rejects(SchemeV2Runtime.open(pin), (error) => error.code === 'E-DUPLICATE-RULE')
})

test('SchemeV2Runtime rejects injectable signature symbols', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.rules[0].signature.inputs = ['x) (define evil 1']
  await assert.rejects(SchemeV2Runtime.open(pin), (error) => error.message === 'E-PIN-SIGNATURE')
})

test('pinEngine rejects malformed or duplicate FFI bindings', () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const subjects = [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }]
  pin.ffi = [
    { id: 'math.add', subjects },
    { id: 'math.add', subjects },
  ]
  assert.throws(() => pinEngine(pin), /E-PIN-FFI/)
  pin.ffi = [{ id: 'bad target', subjects }]
  assert.throws(() => pinEngine(pin), /E-PIN-FFI/)
  pin.ffi = [{ id: 'math.add', subjects: [] }]
  assert.throws(() => pinEngine(pin), /E-PIN-FFI-BINDING/)
})

test('CvmClient close aborts an in-flight host FFI provider', async () => {
  let signal
  const vm = new CvmClient({
    ffi: {
      call: ({ signal: provided }) => {
        signal = provided
        return new Promise(() => {})
      },
    },
    ffiTimeoutMs: 5000,
    ffiTargets: ['math.add'],
  })
  const pending = vm.dispatch(ffiRequest('c1', 'abort-me', 'math.add', '1 2', vm))
  const closed = assert.rejects(pending, (error) => error.code === 'E-VM-CLOSED')
  for (let i = 0; i < 100 && !signal; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(signal)
  await vm.close()
  assert.equal(signal.aborted, true)
  await closed
})

test('CvmClient rejects a reused FFI requestId', async () => {
  const vm = new CvmClient({
    ffi: { call: async ({ args }) => args[0] + args[1] },
    ffiTimeoutMs: 500,
    ffiTargets: ['math.add'],
  })
  try {
    const first = await vm.dispatch(ffiRequest('d1', 'dup', 'math.add', '2 3', vm))
    assert.equal(JSON.parse(first).value, 5)
    await assert.rejects(
      vm.dispatch(ffiRequest('d2', 'dup', 'math.add', '2 3', vm)),
      (error) => error.code === 'E-FFI-REQUEST-REUSED',
    )
    assert.equal(vm.dead, true)
  } finally {
    await vm.close()
  }
})

test('CvmClient kills the VM on malformed or unauthenticated FFI frames', async () => {
  const malformed = new CvmClient({
    ffi: { call: async () => 1 },
    ffiTargets: ['math.add'],
  })
  try {
    await malformed.handleFfiFrame('null')
    assert.equal(malformed.closeReason, 'E-FFI-FRAME')
  } finally {
    await malformed.close()
  }

  const forged = new CvmClient({
    ffi: { call: async () => 1 },
    ffiTargets: ['math.add'],
  })
  try {
    await forged.handleFfiFrame(JSON.stringify({
      id: 'ffi', rid: 'r1', kind: 'ffi', rule: 'spoofed', target: 'math.add', args: [1, 2], token: 'wrong',
    }))
    assert.equal(forged.closeReason, 'E-FFI-FRAME')
  } finally {
    await forged.close()
  }
})

test('CvmClient kills the incarnation when an FFI host call times out', async () => {
  const vm = new CvmClient({
    ffi: { call: () => new Promise(() => {}) },
    ffiTimeoutMs: 50,
    ffiTargets: ['math.add'],
  })
  try {
    await assert.rejects(
      vm.dispatch(ffiRequest('t1', 'slow', 'math.add', '1 2', vm), 1000),
      (error) => error.code === 'E-TIMEOUT',
    )
    await assert.rejects(
      vm.dispatch('(request "t2" get)'),
      (error) => error.code === 'E-VM-DEAD',
    )
  } finally {
    await vm.close()
  }
})

test('CvmClient maps a guest exit to E-VM-EXIT with its code', async () => {
  const vm = new CvmClient()
  try {
    await assert.rejects(
      vm.dispatch('(request "e1" exit 7)'),
      (error) => error.code === 'E-VM-EXIT' && error.exitCode === 7,
    )
  } finally {
    await vm.close()
  }
})

test('SchemeV2Runtime rejects a concurrent call with E-VM-BUSY', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin)
  try {
    const first = runtime.call('rule.example')
    await assert.rejects(runtime.call('rule.example'), (error) => error.code === 'E-VM-BUSY')
    assert.equal(await first, 42)
  } finally {
    await runtime.close()
  }
})

test('SchemeV2Runtime executes a verified pure rule in the long-lived VM', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin)
  try {
    assert.equal(await runtime.call('rule.example'), 42)
    await assert.rejects(runtime.call('missing.rule'), (error) => error.code === 'E-RULE-ID')
  } finally {
    await runtime.close()
  }
})

test('modules are loaded in dependency order rather than pin order', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.modules.reverse()
  const runtime = await SchemeV2Runtime.open(pin)
  try {
    assert.equal(await runtime.call('rule.example'), 42)
  } finally {
    await runtime.close()
  }
})

test('CvmSupervisor survives a killed child and restarts a new incarnation', async () => {
  const supervisor = new CvmSupervisor()
  try {
    const first = JSON.parse(await supervisor.dispatch('(request "s1" get)'))
    assert.equal(first.value, 0)
    const firstPid = supervisor.pid
    assert.ok(firstPid > 0)
    supervisor.kill(new Error('test kill'))
    await assert.rejects(
      supervisor.dispatch('(request "s2" get)'),
      (error) => error.code === 'E-VM-DEAD',
    )
    await supervisor.restart()
    assert.notEqual(supervisor.pid, firstPid)
    const restarted = JSON.parse(await supervisor.dispatch('(request "s3" get)'))
    assert.equal(restarted.value, 0)
  } finally {
    await supervisor.close()
  }
})

test('CvmSupervisor rejects open when the child cannot initialize and close resolves', async () => {
  const supervisor = new CvmSupervisor({ assetDir: join(tmpdir(), 'missing-chez-assets') })
  await assert.rejects(
    supervisor.dispatch('(request "s1" get)'),
    (error) => typeof error.code === 'string',
  )
  await supervisor.close()
})

test('CvmSupervisor close resolves after a killed child', async () => {
  const supervisor = new CvmSupervisor()
  await supervisor.dispatch('(request "s1" get)')
  supervisor.kill(new Error('test kill'))
  await supervisor.close()
})

test('CvmSupervisor rejects a concurrent restart', async () => {
  const supervisor = new CvmSupervisor()
  try {
    await supervisor.dispatch('(request "s1" get)')
    const first = supervisor.restart()
    await assert.rejects(
      supervisor.restart(),
      (error) => error.code === 'E-VM-BUSY',
    )
    await first
    const restarted = JSON.parse(await supervisor.dispatch('(request "s2" get)'))
    assert.equal(restarted.value, 0)
  } finally {
    await supervisor.close()
  }
})

test('SchemeV2Runtime supports FFI pins in supervised mode', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule rule.example (1 0 0))',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.add" 2 3)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{
    id: 'math.add',
    subjects: [{ kind: 'rule', id: 'rule.example', version: [1, 0, 0] }],
  }])
  const runtime = await SchemeV2Runtime.open(pin, {
    supervised: true,
    ffiModules: { math: ffiMathUrl },
  })
  try {
    assert.equal(await runtime.call('rule.example'), 5)
  } finally {
    await runtime.close()
  }
})

test('SchemeV2Runtime can run a pure rule in a supervised child process', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin, { supervised: true })
  try {
    assert.equal(await runtime.call('rule.example'), 42)
    const after = await runtime.gc(2000)
    assert.match(after.text, /"collected":true/)
    await runtime.restart()
    assert.equal(await runtime.call('rule.example'), 42)
  } finally {
    await runtime.close()
  }
})

test('SchemeV2Runtime reports GC and memory metrics', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin)
  try {
    assert.equal(await runtime.call('rule.example'), 42)
    const before = runtime.metrics()
    assert.equal(before.calls, 1)
    assert.equal(before.latencyMs.count, 1)
    assert.equal(before.latencyMs.windowMs, 30000)
    assert.ok(before.latencyMs.p50 >= 0)
    assert.deepEqual(before.errorCodes, {})
    assert.equal(before.restarts, 0)
    assert.ok(before.wasmBytes > 0)
    const after = await runtime.gc(2000)
    assert.match(after.text, /"collected":true/)
    assert.ok(after.rss > 0)
    assert.ok(after.wasmBytes >= before.wasmBytes)
    assert.equal(runtime.metrics().gcs, 1)
  } finally {
    await runtime.close()
  }
})

test('SchemeV2Runtime aborts fail-closed when a live set exceeds Wasm memory', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin)
  await assert.rejects(
    runtime.vm.dispatch('(request "oom" oom ())', 5000),
    (error) => error.code === 'E-VM-ERROR' && /Aborted/.test(error.message),
  )
  await runtime.close()
})

test('a supervised runtime survives live-set OOM and restarts with a clean registry', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin, { supervised: true })
  try {
    await assert.rejects(
      runtime.vm.dispatch('(request "oom" oom ())', 5000),
      (error) => error.code === 'E-VM-ERROR' && /Aborted/.test(error.message),
    )
    await runtime.restart()
    assert.equal(await runtime.call('rule.example'), 42)
    assert.equal(runtime.rules.length, 1)
  } finally {
    await runtime.close()
  }
})

test('SchemeV2Runtime loads a library plugin and calls its exports', async () => {
  const pin = JSON.parse(readFileSync(pluginPinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin, { projectRoot: pluginProjectRoot })
  try {
    assert.equal(await runtime.call('rule.example'), 42)
    assert.equal(await runtime.callPlugin('demo', [1, 0, 0], 'answer'), 42)
    await assert.rejects(
      runtime.callPlugin('demo', [1, 0, 0], 'missing'),
      (error) => error.code === 'E-PLUGIN-EXPORT',
    )
    await assert.rejects(
      runtime.callPlugin('demo', [2, 0, 0], 'answer'),
      (error) => error.code === 'E-PLUGIN-ID',
    )
    await assert.rejects(
      runtime.callPlugin('missing', [1, 0, 0]),
      (error) => error.code === 'E-PLUGIN-ID',
    )
  } finally {
    await runtime.close()
  }
})

test('pinEngine rejects pins with too many rules or plugin sources', () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.rules = Array.from({ length: 65 }, () => ({ ...pin.rules[0] }))
  assert.throws(() => pinEngine(pin), /E-PIN-TOO-LARGE/)
})

test('pinEngine accepts R6RS module names and plugin metadata', () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  assert.equal(projectLibraryName('lib', 'base', [1, 0, 0]), '(dsh lib base (1 0 0))')
  pin.plugins.push({
    id: 'demo',
    version: [1, 0, 0],
    kind: 'library',
    path: 'lib/dsh/plugin/demo/1.0.0.sls',
    treeHash: `sha256:${'a'.repeat(64)}`,
    exports: ['answer'],
    capabilities: [],
  })
  assert.equal(pinEngine(pin), pin)
})

test('pinEngine rejects duplicate plugin id+version but allows another version', () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const plugin = (version) => ({
    id: 'demo',
    version,
    kind: 'library',
    path: `lib/dsh/plugin/demo/${version.join('.')}.sls`,
    treeHash: `sha256:${'a'.repeat(64)}`,
    exports: ['answer'],
    capabilities: [],
  })
  pin.plugins.push(plugin([1, 0, 0]), plugin([1, 0, 0]))
  assert.throws(() => pinEngine(pin), /E-PIN-PLUGIN-DUPLICATE/)
  pin.plugins[1].version = [2, 0, 0]
  pin.plugins[1].path = 'lib/dsh/plugin/demo/2.0.0.sls'
  assert.equal(pinEngine(pin), pin)
})

test('pinEngine rejects legacy string plugins and pre-release version names', () => {
  const legacy = JSON.parse(readFileSync(pinPath, 'utf8'))
  legacy.plugins.push('(dsh plugin demo v1)')
  assert.throws(() => pinEngine(legacy), /E-PIN-PLUGIN-LEGACY/)

  const preRelease = JSON.parse(readFileSync(pinPath, 'utf8'))
  preRelease.modules[0].name = '(dsh lib base v1)'
  assert.throws(() => pinEngine(preRelease), /E-PIN-V2-PRE-RELEASE-NAME/)
})

test('pinEngine rejects inconsistent R6RS module versions and unsafe plugin paths', () => {
  const mismatch = JSON.parse(readFileSync(pinPath, 'utf8'))
  mismatch.modules[0].version = [2, 0, 0]
  assert.throws(() => pinEngine(mismatch), /E-PIN-MODULE-VERSION/)

  const traversal = JSON.parse(readFileSync(pinPath, 'utf8'))
  traversal.plugins.push({
    id: 'demo',
    version: [1, 0, 0],
    kind: 'library',
    path: 'lib/dsh/plugin/demo/../../evil.sls',
    treeHash: `sha256:${'b'.repeat(64)}`,
    exports: ['answer'],
    capabilities: [],
  })
  assert.throws(() => pinEngine(traversal), /E-PIN-PLUGIN-PATH/)
})

test('readPluginFiles mounts only listed files under /project and rejects escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-'))
  const source = '(library (dsh plugin demo (1 0 0))\n  (export answer)\n  (import (rnrs base (6)))\n  (define answer 42))\n'
  const entry = {
    id: 'demo',
    version: [1, 0, 0],
    kind: 'library',
    path: 'lib/dsh/plugin/demo/1.0.0.sls',
    treeHash: `sha256:${'a'.repeat(64)}`,
    exports: ['answer'],
    capabilities: [],
  }
  try {
    mkdirSync(join(root, 'rules', 'scheme', 'lib', 'dsh', 'plugin', 'demo'), { recursive: true })
    writeFileSync(join(root, 'rules', 'scheme', entry.path), source)
    const { sources, projectFiles } = readPluginFiles({ plugins: [entry] }, { projectRoot: root })
    assert.equal(projectFiles.length, 1)
    assert.equal(projectFiles[0].path, '/project/rules/scheme/lib/dsh/plugin/demo/1.0.0.sls')
    assert.equal(projectFiles[0].content, source)
    assert.equal(projectFiles[0].readonly, true)
    assert.equal(sources.get('library:demo:1.0.0'), source)

    const escaping = { ...entry, path: '../outside.sls' }
    assert.throws(
      () => readPluginFiles({ plugins: [escaping] }, { projectRoot: root }),
      (error) => error.message.startsWith('E-PIN-PLUGIN-PATH:'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readPluginFiles rejects a plugin source above the size cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-large-'))
  const entry = {
    id: 'large',
    version: [1, 0, 0],
    kind: 'library',
    path: 'lib/dsh/plugin/large/1.0.0.sls',
    treeHash: `sha256:${'a'.repeat(64)}`,
    exports: ['answer'],
    capabilities: [],
  }
  try {
    mkdirSync(join(root, 'rules', 'scheme', 'lib', 'dsh', 'plugin', 'large'), { recursive: true })
    writeFileSync(join(root, 'rules', 'scheme', entry.path), Buffer.alloc(1024 * 1024 + 1, 0x20))
    assert.throws(
      () => readPluginFiles({ plugins: [entry] }, { projectRoot: root }),
      (error) => error.message.startsWith('E-PIN-TOO-LARGE:plugin:'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
