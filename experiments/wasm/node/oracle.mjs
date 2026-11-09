#!/usr/bin/env node
// Baseline corpus runner and expected-subset comparator.
// The production interpreter is the oracle; engines expose createAdapter().
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const REPO = resolve(ROOT, '..', '..')
const CORPUS_PATH = resolve(ROOT, 'fixtures', 'corpus.json')
const CONTRACT_PATH = resolve(ROOT, 'contract', 'contract.json')

async function productionModules () {
  const rules = await import(pathToFileURL(resolve(REPO, 'lib', 'rules', 'index.js')).href)
  const isolated = await import(pathToFileURL(resolve(REPO, 'lib', 'rules', 'isolated.js')).href)
  return { rules, isolated }
}

function errorResponse (id, error) {
  const response = {
    protocolVersion: 1,
    id,
    ok: false,
    error: {
      code: String(error?.code ?? 'INTERNAL_ERROR'),
      message: String(error?.message ?? error ?? 'unknown error'),
    },
  }
  if (typeof error?.path === 'string' && error.path) response.error.path = error.path
  return response
}

function callResponse (rule, result) {
  if (result && result.ok === false && result.error) {
    return { rule, ok: false, error: result.error }
  }
  return { rule, ok: true, value: result }
}

async function createProductionAdapter () {
  const { rules, isolated } = await productionModules()
  const { RuleRegistry, compileSchemeRule, evaluateSchemeModule } = rules

  function compile (source) {
    return compileSchemeRule(source)
  }

  return {
    name: 'production-interpreter',
    async invoke (request) {
      const id = String(request.id)
      try {
        if (request.op === 'eval') {
          const compiled = compile(request.source)
          return { protocolVersion: 1, id, ok: true, value: await compiled.invoke(request.args ?? []) }
        }

        if (request.op === 'isolated') {
          const limits = request.limits ?? {}
          const value = await isolated.runRuleIsolated(request.source, request.args ?? [], {
            scheme: true,
            timeoutMs: limits.wallTimeoutMs ?? 2000,
            maxOutputBytes: limits.maxOutputBytes ?? 1_000_000,
            limits: limits.maxFuel ? { maxFuel: limits.maxFuel } : {},
          })
          return { protocolVersion: 1, id, ok: true, value }
        }

        if (request.op === 'load-module') {
          const registry = new RuleRegistry()
          const loaded = await rules.loadSchemeRules(request.source, { registry })
          const calls = []
          for (const call of request.calls ?? []) {
            try {
              const value = await loaded.registry.call(call.rule, call.args ?? [])
              calls.push(callResponse(call.rule, value))
            } catch (error) {
              calls.push(callResponse(call.rule, { ok: false, error: errorResponse(id, error).error }))
            }
          }
          return {
            protocolVersion: 1,
            id,
            ok: true,
            stateIds: loaded.registry.ids().slice().sort(),
            ids: loaded.registry.ids().slice().sort(),
            calls,
          }
        }

        return errorResponse(id, { code: 'UNSUPPORTED_OP', message: `unsupported op: ${request.op}` })
      } catch (error) {
        const response = errorResponse(id, error)
        if (request.op === 'load-module') response.stateIds = []
        return response
      }
    },
  }
}

async function loadAdapter (modulePath) {
  if (!modulePath) return createProductionAdapter()
  const url = pathToFileURL(resolve(process.cwd(), modulePath)).href
  const mod = await import(url)
  if (typeof mod.createAdapter !== 'function') {
    throw new Error(`adapter ${modulePath} does not export createAdapter()`)
  }
  return mod.createAdapter({ repoRoot: REPO, experimentsRoot: ROOT })
}

// expected is a contract subset: extra response fields are allowed, but arrays
// and object keys named by expected are authoritative.
function contains (actual, expected, path = '$') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { ok: false, path, message: 'expected array' }
    if (actual.length !== expected.length) return { ok: false, path, message: `expected ${expected.length} items, got ${actual.length}` }
    for (let i = 0; i < expected.length; i++) {
      const found = contains(actual[i], expected[i], `${path}[${i}]`)
      if (!found.ok) return found
    }
    return { ok: true }
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return { ok: false, path, message: 'expected object' }
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) return { ok: false, path: `${path}.${key}`, message: 'missing key' }
      const found = contains(actual[key], value, `${path}.${key}`)
      if (!found.ok) return found
    }
    return { ok: true }
  }
  return Object.is(actual, expected) ? { ok: true } : { ok: false, path, message: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` }
}

async function hashFile (path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

async function runCorpus (adapter, corpus, { caseTimeoutMs = 15000 } = {}) {
  const cases = []
  for (const item of corpus.cases) {
    let response
    let timer
    try {
      response = await Promise.race([
        adapter.invoke(item.request),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`adapter case timeout after ${caseTimeoutMs}ms`), { code: 'ADAPTER_TIMEOUT' })), caseTimeoutMs)
        }),
      ])
    } catch (error) {
      response = errorResponse(item.id, error)
      if (item.request.op === 'load-module') response.stateIds = []
    } finally {
      clearTimeout(timer)
    }
    const match = contains(response, item.expected)
    cases.push({ id: item.id, tier: item.tier, response, match })
    const status = match.ok ? 'PASS' : `FAIL ${match.path} ${match.message}`
    console.log(`${match.ok ? '✓' : '✗'} ${item.id} — ${status}`)
  }
  const failed = cases.filter((item) => !item.match.ok).length
  return { total: cases.length, passed: cases.length - failed, failed, cases }
}

async function baseline (out) {
  const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'))
  const adapter = await createProductionAdapter()
  const run = await runCorpus(adapter, corpus)
  const result = {
    schemaVersion: 1,
    source: 'production-interpreter',
    ok: run.failed === 0,
    generatedAt: new Date().toISOString(),
    corpusHash: await hashFile(CORPUS_PATH),
    contractHash: await hashFile(CONTRACT_PATH),
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    cases: run.cases.map(({ id, tier, response }) => ({ id, tier, response })),
  }
  const target = resolve(out ?? resolve(ROOT, 'results', 'node-oracle.json'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(`\nbaseline: ${run.passed}/${run.total} passed, ${run.failed} failed`)
  console.log(`written: ${target}`)
  return run.failed === 0 ? 0 : 1
}

async function compare (leftPath, rightPath) {
  const left = JSON.parse(await readFile(resolve(leftPath), 'utf8'))
  const right = JSON.parse(await readFile(resolve(rightPath), 'utf8'))
  if (left.corpusHash !== right.corpusHash) {
    console.error('corpus hashes differ; results are not comparable')
    return 2
  }
  const byId = new Map(right.cases.map((item) => [item.id, item.response]))
  let failures = 0
  for (const item of left.cases) {
    if (!byId.has(item.id)) {
      console.error(`✗ ${item.id} — missing from right result`)
      failures++
      continue
    }
    const found = contains(byId.get(item.id), item.response)
    if (!found.ok) {
      console.error(`✗ ${item.id} — ${found.path} ${found.message}`)
      failures++
    } else {
      console.log(`✓ ${item.id}`)
    }
  }
  console.log(`\ncomparison: ${left.cases.length - failures}/${left.cases.length} equal`)
  return failures === 0 ? 0 : 1
}

function usage () {
  console.log(`Usage:
  node oracle.mjs --baseline [--out results/corpus-baseline.json]
  node oracle.mjs --adapter <relative-adapter.mjs> [--out results/<engine>.json]
  node oracle.mjs --compare <baseline.json> <candidate.json>`)
}

async function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.length === 0) {
    usage()
    return 0
  }
  const outIndex = argv.indexOf('--out')
  const out = outIndex >= 0 ? argv[outIndex + 1] : null
  if (argv.includes('--baseline')) return baseline(out)
  const adapterIndex = argv.indexOf('--adapter')
  if (adapterIndex >= 0) {
    const modulePath = argv[adapterIndex + 1]
    if (!modulePath) throw new Error('--adapter requires a module path')
    const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'))
    const adapter = await loadAdapter(modulePath)
    const run = await runCorpus(adapter, corpus)
    const result = {
      schemaVersion: 1,
      source: adapter.name ?? modulePath,
      ok: run.failed === 0,
      generatedAt: new Date().toISOString(),
      corpusHash: await hashFile(CORPUS_PATH),
      contractHash: await hashFile(CONTRACT_PATH),
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      cases: run.cases.map(({ id, tier, response }) => ({ id, tier, response })),
    }
    if (out) {
      await mkdir(dirname(resolve(out)), { recursive: true })
      await writeFile(resolve(out), JSON.stringify(result, null, 2) + '\n', 'utf8')
    }
    console.log(`\n${adapter.name ?? modulePath}: ${run.passed}/${run.total} passed, ${run.failed} failed`)
    return run.failed === 0 ? 0 : 1
  }
  const compareIndex = argv.indexOf('--compare')
  if (compareIndex >= 0) {
    const left = argv[compareIndex + 1]
    const right = argv[compareIndex + 2]
    if (!left || !right) throw new Error('--compare requires two result files')
    return compare(left, right)
  }
  usage()
  return 2
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
