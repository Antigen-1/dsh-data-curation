#!/usr/bin/env node
// Node bridge for the minimal Hoot smoke guest. It deliberately transports only
// the primitive values needed by the four smoke steps; the full corpus adapter
// will add a versioned JSON codec.
import { copyFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const wasmPath = process.argv[2]
const reflectDir = process.argv[3]
if (!wasmPath || !reflectDir) {
  console.error('usage: node boot.mjs <main.wasm> <reflect-wasm-dir>')
  process.exit(2)
}

// Hoot's generated reflect.js is CommonJS, but this checkout is ESM
// ("type": "module"). Load a .cjs copy rather than reinterpreting the bundle.
const reflectCjs = resolve(reflectDir, 'reflect.cjs')
if (!existsSync(reflectCjs)) {
  copyFileSync(resolve(reflectDir, 'reflect.js'), reflectCjs)
}
const hoot = createRequire(import.meta.url)(reflectCjs)
const values = await hoot.Scheme.load_main(resolve(wasmPath), {
  reflect_wasm_dir: resolve(reflectDir),
  user_imports: {},
})
const dispatch = values[0]
if (!dispatch || typeof dispatch.call !== 'function') {
  throw new Error('Hoot program did not return a callable dispatch procedure')
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of rl) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
    const result = await dispatch.call(
      String(request.op),
      String(request.source ?? ''),
      request.a ?? false,
      request.b ?? false,
      request.c ?? false,
      request.d ?? false,
    )
    process.stdout.write(JSON.stringify({ ok: true, value: result[0] }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: { code: String(error?.code ?? 'HOOT_EVAL_ERROR'), message: String(error?.message ?? error) },
    }) + '\n')
  }
}
