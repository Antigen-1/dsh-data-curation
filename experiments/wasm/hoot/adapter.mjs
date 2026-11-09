#!/usr/bin/env node
// Phase-1 minimal Hoot adapter. It runs the boot script in a child process so a
// runaway guest can be killed without taking down the corpus runner.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOT = resolve(HERE, 'boot.mjs')
const WASM = process.env.HOOT_WASM ?? resolve(HERE, 'main.wasm')
const REFLECT_DIR = process.env.HOOT_REFLECT_DIR ?? resolve(HERE, 'reflect')

function failure (request, code, message) {
  return {
    protocolVersion: 1,
    id: String(request.id),
    ok: false,
    error: { code, message },
    ...(request.op === 'load-module' ? { stateIds: [] } : {}),
  }
}

async function runBoot (requests, { wallTimeoutMs = 2000, maxOutputBytes = 1_000_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BOOT, WASM, REFLECT_DIR], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const responses = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolvePromise(value)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: 'TIMEOUT', message: `Hoot smoke exceeded ${wallTimeoutMs}ms` } })
    }, wallTimeoutMs)

    createInterface({ input: child.stdout }).on('line', (line) => {
      stdoutBytes += Buffer.byteLength(line) + 1
      if (stdoutBytes > maxOutputBytes) {
        finish({ ok: false, error: { code: 'OUTPUT_LIMIT', message: `Hoot output exceeded ${maxOutputBytes} bytes` } })
        return
      }
      try {
        responses.push(JSON.parse(line))
      } catch {
        finish({ ok: false, error: { code: 'PROTOCOL_ERROR', message: 'Hoot boot emitted a non-JSON line' } })
        return
      }
      if (responses.length === requests.length) finish({ ok: true, responses })
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        finish({ ok: false, error: { code: 'OUTPUT_LIMIT', message: 'Hoot stderr exceeded output limit' } })
      }
    })
    child.on('error', (error) => finish({ ok: false, error: { code: 'PROTOCOL_ERROR', message: String(error.message ?? error) } }))
    child.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: { code: 'PROTOCOL_ERROR', message: `Hoot boot exited ${code}: ${stderr.trim()}` } })
    })
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n')
  })
}

export async function createAdapter () {
  return {
    name: 'hoot',
    async invoke (request) {
      const limits = request.limits ?? {}
      const wallTimeoutMs = limits.wallTimeoutMs ?? 2000
      const maxOutputBytes = limits.maxOutputBytes ?? 1_000_000
      if (request.op === 'capabilities') {
        return {
          protocolVersion: 1,
          id: String(request.id),
          ok: true,
          levels: ['fixed-aot', 'pure-dynamic'],
          features: { dynamicEval: true, dynamicRegister: true, asyncFfi: false },
          imports: [],
          limits: { wallTimeoutMs, maxOutputBytes, memoryBytes: 'unfrozen' },
        }
      }
      if (!['eval', 'load-module', 'isolated'].includes(request.op)) {
        return failure(request, 'UNSUPPORTED', `unsupported op: ${request.op}`)
      }
      if (request.op === 'eval') {
        const run = await runBoot([{ op: 'eval', source: request.source, a: (request.args ?? [])[0] ?? false }], { wallTimeoutMs, maxOutputBytes })
        if (!run.ok) return failure(request, run.error.code, run.error.message)
        const first = run.responses[0]
        if (!first.ok) return failure(request, first.error?.code ?? 'EVAL_ERROR', first.error?.message ?? 'Hoot eval failed')
        return { protocolVersion: 1, id: String(request.id), ok: true, value: first.value }
      }
      if (request.op === 'load-module') {
        const requests = [{ op: 'load-module', source: request.source }]
        for (const call of request.calls ?? []) {
          requests.push({ op: 'call', source: call.rule, a: (call.args ?? [])[0] ?? false })
        }
        const run = await runBoot(requests, { wallTimeoutMs, maxOutputBytes })
        if (!run.ok) return failure(request, run.error.code, run.error.message)
        const load = run.responses[0]
        if (!load.ok) return failure(request, load.error?.code ?? 'EVAL_ERROR', load.error?.message ?? 'Hoot module load failed')
        const calls = (request.calls ?? []).map((call, index) => {
          const response = run.responses[index + 1]
          return response?.ok
            ? { rule: call.rule, ok: true, value: response.value }
            : { rule: call.rule, ok: false, error: response?.error ?? { code: 'EVAL_ERROR', message: 'missing call response' } }
        })
        return {
          protocolVersion: 1,
          id: String(request.id),
          ok: true,
          stateIds: [],
          ids: [],
          calls,
        }
      }
      const run = await runBoot([{ op: 'eval', source: request.source, a: (request.args ?? [])[0] ?? false }], { wallTimeoutMs, maxOutputBytes })
      if (!run.ok) return failure(request, run.error.code, run.error.message)
      const first = run.responses[0]
      if (!first.ok) return failure(request, first.error?.code ?? 'EVAL_ERROR', first.error?.message ?? 'Hoot eval failed')
      return { protocolVersion: 1, id: String(request.id), ok: true, value: first.value }
    },
  }
}
