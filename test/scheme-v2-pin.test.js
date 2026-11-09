import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadSchemeV2Pin, loadSchemeV2PinFile, SchemeV2Runtime } from '../lib/rules/index.js'
import { CvmClient } from '../lib/rules/scheme/v2/client.js'
import { decodeSourceBase64, schemeString } from '../lib/rules/scheme/v2/pin-lib.js'

const pinPath = fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-a.json', import.meta.url))

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
    return `(${schemeString(module.name)} ${schemeString(module.version)} ${schemeString(moduleSource)})`
  }).join(' ')})`
  const ffiDatum = `(${pin.ffi.map((entry) => `(${schemeString(JSON.stringify(entry))})`).join(' ')})`
  const vm = new CvmClient()
  try {
    const raw = await vm.dispatch(`(request "verify" pin-verify (rule ${schemeString('rule.example')} ${schemeString('1.0.0')} ${schemeString(source)} ${modulesDatum} () ${ffiDatum} (signature () number #f)))`)
    const value = JSON.parse(raw).value
    for (const field of ['treeHash', 'bundleHash', 'pluginEnvironmentHash', 'ffiEnvironmentHash', 'ruleHash']) {
      pin.rules[0][field] = value[field]
    }
  } finally {
    await vm.close()
  }
  return pin
}

test('loadSchemeV2Pin verifies hashes and publishes metadata only after all rules pass', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const loaded = await loadSchemeV2Pin(pin)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.loaded, true)
  assert.equal(loaded.project, 'pin-v2-fixture-a')
  assert.equal(loaded.rules.length, 1)
  assert.equal(loaded.rules[0].id, 'rule.example')
  assert.deepEqual(loaded.modules.map((module) => module.name), ['(dsh lib base v1)', '(dsh lib math v1)'])
  assert.match(loaded.engine.engineArtifactHash, /^sha256:[0-9a-f]{64}$/)
})

test('loadSchemeV2Pin rejects a tampered expected hash without returning metadata', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.rules[0].treeHash = '0'.repeat(64)
  await assert.rejects(loadSchemeV2Pin(pin), /E-PIN-MISMATCH:treeHash/)
})

test('loadSchemeV2PinFile reads the pin from disk', async () => {
  const loaded = await loadSchemeV2PinFile(pinPath)
  assert.equal(loaded.loaded, true)
  assert.equal(loaded.rules.length, 1)
})

test('SchemeV2Runtime refuses FFI declarations until the host bridge is wired', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.ffi = [{ id: 'math.add' }]
  await assert.rejects(SchemeV2Runtime.open(pin), (error) => error.code === 'E-V2-FFI-UNSUPPORTED')
})

test('SchemeV2Runtime refuses host FFI when the pin declares none', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  await assert.rejects(
    SchemeV2Runtime.open(pin, { ffi: { call: async () => 1 } }),
    (error) => error.code === 'E-V2-FFI-UNDECLARED',
  )
})

test('CvmClient services a blocking FFI frame from an explicit host map', async () => {
  const calls = []
  const vm = new CvmClient({
    ffi: {
      call: async ({ target, args }) => {
        calls.push({ target, args })
        if (target === 'math.fail') {
          const error = new Error('host rejected')
          error.code = 'E-FFI-HOST'
          throw error
        }
        return args[0] + args[1]
      },
    },
    ffiTimeoutMs: 500,
    ffiTargets: ['math.add', 'math.fail'],
  })
  try {
    const raw = await vm.dispatch(ffiRequest('f1', 'r1', 'math.add', '2 3', vm))
    assert.deepEqual(JSON.parse(raw), { id: 'f1', ok: true, value: 5 })
    const failure = await vm.dispatch(ffiRequest('f2', 'r2', 'math.fail', '1 2', vm))
    assert.equal(JSON.parse(failure).error.code, 'E-FFI-HOST')
    const undeclared = await vm.dispatch(ffiRequest('f3', 'r3', 'math.undeclared', '1 2', vm))
    assert.equal(JSON.parse(undeclared).error.code, 'E-FFI-NOT-DECLARED')
    assert.deepEqual(calls.map((entry) => entry.target), ['math.add', 'math.fail'])
  } finally {
    await vm.close()
  }
})

test('a verified rule imports (dsh ffi (6)) and calls an allowlisted host target', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule example v1)',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.add" 2 3)))',
    '',
  ].join('\n')
  pin.rules[0].sourceBase64 = Buffer.from(source, 'utf8').toString('base64')
  pin.rules[0].signature = { inputs: [], output: 'number', variadic: false }
  pin.ffi = [{ id: 'math.add' }]

  const modulesDatum = `(${pin.modules.map((module) => {
    const moduleSource = decodeSourceBase64(module.sourceBase64)
    return `(${schemeString(module.name)} ${schemeString(module.version)} ${schemeString(moduleSource)})`
  }).join(' ')})`
  const ffiDatum = `(${pin.ffi.map((entry) => `(${schemeString(JSON.stringify(entry))})`).join(' ')})`
  const vm = new CvmClient()
  try {
    const raw = await vm.dispatch(`(request "verify-ffi" pin-verify (rule ${schemeString('rule.example')} ${schemeString('1.0.0')} ${schemeString(source)} ${modulesDatum} () ${ffiDatum} (signature () number #f)))`)
    const value = JSON.parse(raw).value
    for (const field of ['treeHash', 'bundleHash', 'pluginEnvironmentHash', 'ffiEnvironmentHash', 'ruleHash']) {
      pin.rules[0][field] = value[field]
    }
  } finally {
    await vm.close()
  }

  const runtime = await SchemeV2Runtime.open(pin, {
    ffi: {
      call: async ({ target, args }) => {
        assert.equal(target, 'math.add')
        return args[0] + args[1]
      },
    },
  })
  try {
    assert.equal(await runtime.call('rule.example'), 5)
    assert.equal(await runtime.ffiCall('math.add', [4, 5]), 9)
    assert.equal(await runtime.ffiCall('math.add', [6, 7]), 13)
  } finally {
    await runtime.close()
  }
})

test('a verified rule cannot escape to (chezscheme) or read the bridge token', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule example v1)',
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

test('a verified rule cannot import (dsh ffi (6)) to forge another rule identity', async () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const source = [
    '(library (dsh rule example v1)',
    '  (export entry)',
    '  (import (rnrs base (6)) (dsh ffi (6)))',
    '  (define (entry) (ffi-call "math.add" 1 2)))',
    '',
  ].join('\n')
  await rehashRule(pin, source, [{ id: 'math.add' }])
  const calls = []
  const runtime = await SchemeV2Runtime.open(pin, {
    ffi: {
      call: async ({ ruleHash, target, args }) => {
        calls.push({ ruleHash, target })
        return args[0] + args[1]
      },
    },
  })
  try {
    assert.equal(await runtime.call('rule.example'), 3)
    assert.equal(calls[0].ruleHash, pin.rules[0].ruleHash)
    assert.equal(calls[0].ruleHash.length, 64)
    assert.equal(await runtime.ffiCall('math.add', [4, 5]), 9)
    assert.equal(calls[1].ruleHash, '@host')
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
    const second = await vm.dispatch(ffiRequest('d2', 'dup', 'math.add', '2 3', vm))
    assert.equal(JSON.parse(second).error.code, 'E-FFI-REQUEST-REUSED')
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
