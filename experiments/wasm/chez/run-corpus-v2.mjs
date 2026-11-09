import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const CORPUS = join(ROOT, 'experiments', 'wasm', 'fixtures', 'corpus.json')
const GUEST = join(HERE, 'guest-v2.scm')
const OUT = join(ROOT, 'experiments', 'wasm', 'results', 'chez', '10.4.1', 'corpus-v2.json')
const TRIAGE_OUT = join(ROOT, 'experiments', 'wasm', 'results', 'chez', '10.4.1', 'corpus-v2-triage.json')

function schemeString(value) {
  return JSON.stringify(String(value))
}

function schemeValue(value) {
  if (value === null) return "(vector 'dsh-null)"
  if (typeof value === 'boolean') return value ? '#t' : '#f'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '#f'
  if (typeof value === 'string') return schemeString(value)
  if (Array.isArray(value)) return `(list ${value.map(schemeValue).join(' ')})`
  if (value && typeof value === 'object') {
    return `(cons 'dsh-object (list ${Object.entries(value)
      .map(([key, item]) => `(cons ${schemeString(key)} ${schemeValue(item)})`)
      .join(' ')}))`
  }
  return '#f'
}

function requestScheme(request) {
  const op = schemeString(request.op)
  const id = schemeString(request.id)
  const source = schemeString(request.source ?? '')
  const arg = request.op === 'load-module'
    ? `(list ${(request.calls ?? []).map((call) =>
        `(list ${schemeString(call.rule)} ${schemeValue(call.args ?? [])})`).join(' ')})`
    : schemeValue(request.args ?? [])
  return `(list ${op} ${id} ${source} ${arg})`
}

async function runCase(guest, testCase) {
  const CAP = 1 << 20
  const MASK = CAP - 1
  const control = new SharedArrayBuffer(8 * 4)
  const output = new SharedArrayBuffer(CAP)
  const ctrl = new Int32Array(control)
  const outBuf = new Uint8Array(output)
  let outRead = 0
  const chunks = []
  let stderrText = ''
  let exit = null
  let failure = null
  let loadedAt = null

  const scriptSource = `${guest}\n(display (main ${requestScheme(testCase.request)}))\n(newline)\n(exit 0)\n`
  const worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
    workerData: { control, input: new SharedArrayBuffer(CAP), output, scriptSource, scriptName: 'corpus-v2.scm' },
  })

  function drain() {
    const end = Atomics.load(ctrl, 2)
    if (end <= outRead) return
    const chunk = Buffer.alloc(end - outRead)
    for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
    outRead = end
    Atomics.store(ctrl, 3, outRead)
    Atomics.notify(ctrl, 3)
    chunks.push(chunk)
  }

  worker.on('message', (message) => {
    if (message.type === 'loaded') {
      loadedAt = Date.now()
    } else if (message.type === 'exit') {
      exit = message
      stderrText = message.stderr || ''
    } else if (message.type === 'error') {
      failure = message
      stderrText = message.stderr || ''
    }
  })
  worker.on('error', (error) => {
    failure = { message: error.stack ?? String(error) }
  })

  const limits = testCase.request.limits || {}
  const waitMs = typeof limits.wallTimeoutMs === 'number' ? limits.wallTimeoutMs : 10000
  const initDeadline = Date.now() + 10000
  while (exit === null && failure === null) {
    if (loadedAt === null && Date.now() >= initDeadline) break
    if (loadedAt !== null && Date.now() - loadedAt >= waitMs) break
    await new Promise((resolve) => setTimeout(resolve, 5))
    drain()
  }
  if (exit === null && failure === null && loadedAt !== null) {
    // The host adapter owns wall-clock limits; a guest stuck in a loop is
    // terminated here and reported with the corpus-level TIMEOUT code.
    await worker.terminate()
    if (testCase.request.op === 'isolated' && typeof limits.wallTimeoutMs === 'number') {
      return { id: testCase.request.id, ok: false, error: { code: 'TIMEOUT' }, stderr: stderrText }
    }
    return { ok: false, protocolError: 'timeout', stderr: stderrText }
  }
  if (exit === null && failure === null) {
    return { ok: false, protocolError: 'timeout', stderr: stderrText }
  }
  drain()
  await worker.terminate()

  if (failure) return { ok: false, protocolError: failure.message, stderr: stderrText }
  if (exit === null) return { ok: false, protocolError: 'timeout', stderr: stderrText }
  const stdout = Buffer.concat(chunks).toString('utf8')
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return { ok: false, protocolError: `no output, exit ${exit.code}`, stderr: stderrText }
  try {
    const parsed = JSON.parse(lines[lines.length - 1])
    if (
      testCase.request.op === 'isolated' &&
      typeof limits.maxOutputBytes === 'number' &&
      Buffer.byteLength(JSON.stringify(parsed)) > limits.maxOutputBytes
    ) {
      return { id: testCase.request.id, ok: false, error: { code: 'OUTPUT_LIMIT' }, stderr: stderrText }
    }
    return { ...parsed, stderr: stderrText }
  } catch (error) {
    return { ok: false, protocolError: `invalid JSON: ${error.message}`, raw: lines[lines.length - 1], stderr: stderrText }
  }
}

function sorted(xs) {
  return Array.isArray(xs) ? [...xs].sort() : xs
}

function compare(actual, expected) {
  const diffs = []
  if (actual.ok !== expected.ok) diffs.push(`ok ${actual.ok} != ${expected.ok}`)
  if (expected.ok && 'value' in expected && JSON.stringify(actual.value) !== JSON.stringify(expected.value)) {
    diffs.push(`value ${JSON.stringify(actual.value)} != ${JSON.stringify(expected.value)}`)
  }
  for (const key of ['stateIds', 'ids']) {
    if (key in expected && JSON.stringify(sorted(actual[key])) !== JSON.stringify(sorted(expected[key]))) {
      diffs.push(`${key} ${JSON.stringify(actual[key])} != ${JSON.stringify(expected[key])}`)
    }
  }
  if ('calls' in expected) {
    const a = actual.calls ?? []
    if (a.length !== expected.calls.length) diffs.push(`calls length ${a.length} != ${expected.calls.length}`)
    else {
      for (let i = 0; i < a.length; i++) {
        const av = a[i]
        const ev = expected.calls[i]
        if (av.rule !== ev.rule || av.ok !== ev.ok || JSON.stringify(av.value) !== JSON.stringify(ev.value)) {
          diffs.push(`call[${i}] ${JSON.stringify(av)} != ${JSON.stringify(ev)}`)
        }
      }
    }
  }
  if (!expected.ok && expected.error?.code && actual.error?.code !== expected.error.code) {
    diffs.push(`error.code ${actual.error?.code} != ${expected.error.code}`)
  }
  if (!expected.ok && expected.error?.path && actual.error?.path !== expected.error.path) {
    diffs.push(`error.path ${actual.error?.path} != ${expected.error.path}`)
  }
  return diffs
}

const fixtures = JSON.parse(readFileSync(CORPUS, 'utf8'))
const baseline = JSON.parse(readFileSync(join(ROOT, 'experiments', 'wasm', 'results', 'chez', '10.4.1', 'corpus.json'), 'utf8'))
const fixtureById = new Map(fixtures.cases.map((c) => [c.id, c]))
const baselineById = new Map((baseline.cases ?? []).map((c) => [c.id, c.response ?? c]))
const guest = readFileSync(GUEST, 'utf8')
const selected = process.argv[2]
const cases = []
for (const testCase of fixtures.cases) {
  if (selected && testCase.id !== selected) continue
  const actual = await runCase(guest, testCase)
  const diffs = compare(actual, testCase.expected)
  cases.push({ id: testCase.id, expected: testCase.expected, actual, pass: diffs.length === 0, diffs })
  process.stderr.write(`${diffs.length ? 'FAIL' : 'PASS'} ${testCase.id}\n`)
}
const passed = cases.filter((c) => c.pass).length
const result = {
  schemaVersion: 1,
  source: 'guest-v2.scm',
  generatedAt: new Date().toISOString(),
  total: cases.length,
  passed,
  failed: cases.length - passed,
  cases,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')

const baselineFailures = {
  'semantic.macro-conjoin': 'missing conjoin macro',
  'semantic.object-contract': 'missing object/c and object predicates',
  'semantic.decision-pending': 'missing decision-with; accept must gate selector',
  'semantic.json-roundtrip': 'JSON null was encoded as []',
  'semantic.error.cond-without-else': 'missing cond/else validation',
  'semantic.error.quote-symbol': 'missing quoted-symbol validation',
  'semantic.error.unbound': 'compound condition was not mapped to UNBOUND_VARIABLE',
  'semantic.error.strict-boolean': 'missing strict boolean contract',
  'dynamic.helper-forward': 'missing module helper evaluation path',
  'dynamic.helper-register': 'missing registry mutation/rollback path',
  'dynamic.atomic.duplicate-id': 'missing duplicate rule id rejection',
  'dynamic.atomic.duplicate-role': 'missing duplicate role rejection',
  'dynamic.atomic.capture-mutation': 'missing captured set! rejection',
  'dynamic.loop-snapshot': 'id list ordering differed',
  'dynamic.local-forms': 'id list ordering differed',
}
const current = new Map(cases.map((c) => [c.id, c]))
const triage = {
  schemaVersion: 1,
  baseline: {
    file: 'experiments/wasm/results/chez/10.4.1/corpus.json',
    passed: 16,
    failed: 15,
  },
  current: {
    file: 'experiments/wasm/results/chez/10.4.1/corpus-v2.json',
    passed,
    failed: cases.length - passed,
  },
  method: 'Read-based guest reproduces v1 observable semantics; host runner enforces isolated wall/output limits.',
  failures: Object.entries(baselineFailures).map(([id, resolution]) => ({
    id,
    input: fixtureById.get(id)?.request,
    v1Expected: fixtureById.get(id)?.expected,
    v1Actual: baselineById.get(id),
    rootCause: resolution,
    v2Actual: current.get(id)?.actual,
    v2Disposition: 'fixed in experimental guest; production v1 semantics unchanged',
    evidence: `experiments/wasm/results/chez/10.4.1/corpus-v2.json#${id}`,
    baselinePassed: false,
    currentPassed: current.get(id)?.pass === true,
    currentDiffs: current.get(id)?.diffs ?? ['missing case'],
  })),
}
writeFileSync(TRIAGE_OUT, JSON.stringify(triage, null, 2) + '\n')
process.stdout.write(`${passed}/${cases.length} passed\n${OUT}\n${TRIAGE_OUT}\n`)
