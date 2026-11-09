import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'results', 'chez', '10.4.1-c')
const OUT = join(OUT_DIR, 'remediation-regressions.json')

const tests = [
  'test-online-vm-c.mjs',
  'test-online-vm-c-supervision.mjs',
  'test-memfs-c.mjs',
  'test-memfs-quota-c.mjs',
  'test-memfs-links-c.mjs',
  'test-blocking-ffi-c.mjs',
  'test-blocking-broker-c.mjs',
  'test-host-bridge-c.mjs',
  'test-output-cap-c.mjs',
  'test-plugin-ab-c.mjs',
  'test-pin-v2.mjs',
  'test-incarnation-timeout.mjs',
  'test-ffi-abort-c.mjs',
  'test-plugin-runtime.mjs',
  'test-engine-registry-negative.mjs',
  'test-ffi-types.mjs',
  'test-bundle-hash.mjs',
  'test-cross-side-bundle.mjs',
  'test-pin-load-imports.mjs',
  'test-source-tree.mjs',
  'test-source-tree-oracle.mjs',
  'test-sha-vectors.mjs',
  'test-namespace.mjs',
  'test-r6rs-matrix.mjs',
]
const suites = ['run-plugin-isolation.mjs', 'run-corpus-v2.mjs']

const legacy = [
  { file: 'test-host-bridge.mjs', reason: 'legacy Worker/SAB + libffi transport; superseded by blocking C ABI bridge' },
  { file: 'test-host-capabilities.mjs', reason: 'legacy two-phase suspended/resumed protocol; superseded by blocking broker tests' },
  { file: 'test-suspend-c.mjs', reason: 'two-phase resume was rejected; blocking model has no continuation resume' },
  { file: 'test-script-output.mjs', reason: 'argument-required helper, not a standalone test' },
]

const results = []
for (const file of [...tests, ...suites]) {
  const started = process.hrtime.bigint()
  const run = spawnSync(process.execPath, [join(HERE, file)], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  })
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6
  const stderr = run.stderr || ''
  const stdout = run.stdout || ''
  const pass = run.status === 0
  results.push({
    file,
    pass,
    exitCode: run.status,
    durationMs: Math.round(durationMs),
    stderrTail: stderr.slice(-1200),
    stdoutTail: stdout.slice(-1200),
  })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${file} (${run.status}, ${Math.round(durationMs)} ms)`)
  if (!pass) {
    process.stderr.write(stderr.slice(-4000))
    process.stderr.write(stdout.slice(-4000))
  }
}

const failed = results.filter((entry) => !entry.pass)
const payload = {
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((entry) => entry.file),
  results,
  notRun: legacy,
  boundary: '26 = 24 current C ABI profile tests + 2 retained coverage suites: run-plugin-isolation.mjs uses the legacy 10.4.1 assets, and run-corpus-v2.mjs writes legacy 10.4.1 results. Legacy transport and standalone helper scripts are excluded; see notRun.',
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({ ok: payload.ok, total: payload.total, passed: payload.passed, failed: payload.failed, out: OUT }, null, 2))
if (!payload.ok) process.exitCode = 1
