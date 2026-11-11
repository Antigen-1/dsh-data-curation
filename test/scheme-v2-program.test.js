import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SchemeV2Runtime } from '../lib/rules/index.js'
import { CvmClient } from '../lib/rules/scheme/v2/client.js'
import { schemeString } from '../lib/rules/scheme/v2/pin-lib.js'

const programPinPath = fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-program-a.json', import.meta.url))
const programProjectRoot = fileURLToPath(new URL('./fixtures/scheme-v2/program-project', import.meta.url))
const programFfiPinPath = fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-program-ffi-a.json', import.meta.url))
const programFfiProjectRoot = fileURLToPath(new URL('./fixtures/scheme-v2/program-ffi-project', import.meta.url))
const ffiMathUrl = new URL('./fixtures/scheme-v2/ffi/math.mjs', import.meta.url).href
const rulePinPath = fileURLToPath(new URL('./fixtures/scheme-v2/pin-v2-program-static-a.json', import.meta.url))
const ruleProjectRoot = fileURLToPath(new URL('./fixtures/scheme-v2/program-static-project', import.meta.url))

async function programPinWith (source, basePinPath = programPinPath) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-program-'))
  const programPath = 'programs/010-bootstrap.scm'
  mkdirSync(join(projectRoot, 'rules', 'scheme', 'programs'), { recursive: true })
  writeFileSync(join(projectRoot, 'rules', 'scheme', programPath), source)
  const vm = new CvmClient()
  let treeHash
  try {
    const raw = await vm.dispatch(`(request "hash" source-tree-hash ${schemeString(source)})`)
    const response = JSON.parse(raw)
    if (!response.ok) throw new Error(raw)
    treeHash = `sha256:${response.value}`
  } finally {
    await vm.close()
  }
  const pin = JSON.parse(readFileSync(basePinPath, 'utf8'))
  pin.plugins = [{
    id: 'bootstrap',
    version: [1],
    kind: 'program',
    path: programPath,
    treeHash,
    capabilities: [],
  }]
  return { pin, projectRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) }
}

test('SchemeV2Runtime executes programs and registers dynamic rules', async () => {
  const pin = JSON.parse(readFileSync(programPinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin, { projectRoot: programProjectRoot })
  try {
    assert.deepEqual(runtime.programs, [{
      id: 'bootstrap',
      version: [1],
      result: ['strict', 42],
    }])
    assert.deepEqual(runtime.programResult('bootstrap', [1]), ['strict', 42])
    assert.equal(runtime.rules.length, 1)
    assert.equal(runtime.rules[0].id, 'total')
    assert.deepEqual(runtime.rules[0].version, [1, 0, 0])
    assert.equal(runtime.rules[0].source, 'program')
    assert.match(runtime.rules[0].subject, /^[0-9a-f]{64}$/)
    assert.equal(await runtime.callRule('total', [1, 0, 0], [21]), 42)
    await assert.rejects(
      runtime.callPlugin('bootstrap', [1], 'entry'),
      (error) => error.code === 'E-PLUGIN-NOT-CALLABLE',
    )
    assert.throws(
      () => runtime.programResult('missing', [1]),
      (error) => error.code === 'E-PROGRAM-ID',
    )
  } finally {
    await runtime.close()
  }
})

test('programs may register the same rule id at different versions', async () => {
  const fixture = await programPinWith([
    '(import (rnrs base (6)) (dsh rules (6)))',
    "(register-rule! 'total '(1) (lambda () 1))",
    "(register-rule! 'total '(2) (lambda () 2))",
    '42',
    '',
  ].join('\n'))
  try {
    const runtime = await SchemeV2Runtime.open(fixture.pin, { projectRoot: fixture.projectRoot })
    try {
      assert.equal(await runtime.callRule('total', [1]), 1)
      assert.equal(await runtime.callRule('total', [2]), 2)
      assert.equal(runtime.rules.length, 2)
    } finally {
      await runtime.close()
    }
  } finally {
    fixture.cleanup()
  }
})

test('program registration is recreated on each open', async () => {
  const pin = JSON.parse(readFileSync(programPinPath, 'utf8'))
  const first = await SchemeV2Runtime.open(pin, { projectRoot: programProjectRoot })
  await first.close()
  const second = await SchemeV2Runtime.open(pin, { projectRoot: programProjectRoot })
  try {
    assert.equal(await second.callRule('total', [1, 0, 0], [21]), 42)
  } finally {
    await second.close()
  }
})

test('program failure prevents open and returns no runtime', async () => {
  const fixture = await programPinWith([
    '(import (rnrs base (6)))',
    "(car '())",
    '',
  ].join('\n'))
  try {
    await assert.rejects(
      SchemeV2Runtime.open(fixture.pin, { projectRoot: fixture.projectRoot }),
      (error) => error.code === 'E-PLUGIN-ERROR',
    )
  } finally {
    fixture.cleanup()
  }
})

test('program exit maps to E-PLUGIN-EXIT and closes the VM', async () => {
  const fixture = await programPinWith([
    '(import (rnrs base (6)) (rnrs programs (6)))',
    '(exit 7)',
    '',
  ].join('\n'))
  try {
    await assert.rejects(
      SchemeV2Runtime.open(fixture.pin, { projectRoot: fixture.projectRoot }),
      (error) => error.code === 'E-PLUGIN-EXIT' && error.exitCode === 7,
    )
  } finally {
    fixture.cleanup()
  }
})

test('program cannot register the same dynamic rule twice', async () => {
  const fixture = await programPinWith([
    '(import (rnrs base (6)) (dsh rules (6)))',
    "(register-rule! 'total '(1 0 0) (lambda () 1))",
    "(register-rule! 'total '(1 0 0) (lambda () 2))",
    '42',
    '',
  ].join('\n'))
  try {
    await assert.rejects(
      SchemeV2Runtime.open(fixture.pin, { projectRoot: fixture.projectRoot }),
      (error) => error.code === 'E-DUPLICATE-RULE',
    )
  } finally {
    fixture.cleanup()
  }
})

test('program cannot override a static rule', async () => {
  const pin = JSON.parse(readFileSync(rulePinPath, 'utf8'))
  await assert.rejects(
    SchemeV2Runtime.open(pin, { projectRoot: ruleProjectRoot }),
    (error) => error.code === 'E-DUPLICATE-RULE',
  )
})

test('programResult reports E-VM-CLOSED after close', async () => {
  const pin = JSON.parse(readFileSync(programPinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin, { projectRoot: programProjectRoot })
  await runtime.close()
  assert.throws(
    () => runtime.programResult('bootstrap', [1]),
    (error) => error.code === 'E-VM-CLOSED',
  )
})

test('a supervised program can use bound FFI and its dynamic rule inherits authorization', async () => {
  const pin = JSON.parse(readFileSync(programFfiPinPath, 'utf8'))
  const runtime = await SchemeV2Runtime.open(pin, {
    projectRoot: programFfiProjectRoot,
    supervised: true,
    ffiModules: { math: ffiMathUrl },
  })
  try {
    assert.deepEqual(runtime.programResult('ffi-bootstrap', [1]), [42, 42])
    assert.equal(await runtime.callRule('ffi-total', [1, 0, 0], [21]), 42)
    await runtime.restart()
    assert.deepEqual(runtime.programResult('ffi-bootstrap', [1]), [42, 42])
    assert.equal(await runtime.callRule('ffi-total', [1, 0, 0], [21]), 42)
  } finally {
    await runtime.close()
  }
})
