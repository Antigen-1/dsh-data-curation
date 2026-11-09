import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CvmClient } from './client.js'
import {
  decodeSourceBase64,
  pinEngine,
  schemeString,
  schemeValue,
  verifyEngine,
} from './pin-lib.js'

const DEFAULT_ASSETS_ROOT = fileURLToPath(new URL('../../../../assets/chez-wasm/', import.meta.url))
const DEFAULT_REGISTRY = join(DEFAULT_ASSETS_ROOT, 'engine-registry.json')

function normalizeHash (value, field) {
  if (typeof value !== 'string') throw new Error(`E-PIN-${field}`)
  const raw = value.startsWith('sha256:') ? value.slice(7) : value
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`E-PIN-${field}`)
  return raw
}

function schemeSymbol (value) {
  if (typeof value !== 'string' || !/^[A-Za-z!$%&*/:<=>?^_~][A-Za-z0-9!$%&*/:<=>?^_~+\-.]*$/.test(value)) {
    throw new Error('E-PIN-SIGNATURE')
  }
  return value
}

function signatureDatum (signature) {
  if (!signature || !Array.isArray(signature.inputs) || typeof signature.output !== 'string') {
    throw new Error('E-PIN-SIGNATURE')
  }
  const inputs = signature.inputs.map((x) => schemeSymbol(String(x))).join(' ')
  return `(signature (${inputs}) ${schemeSymbol(signature.output)} ${signature.variadic === true ? '#t' : '#f'})`
}

function moduleDatum (module) {
  if (typeof module.name !== 'string' || typeof module.version !== 'string') {
    throw new Error('E-PIN-MODULE')
  }
  return `(${schemeString(module.name)} ${schemeString(module.version)} ${schemeString(decodeSourceBase64(module.sourceBase64))})`
}

function moduleNames (parsed) {
  return parsed.modules.map((module) => ({ name: module.name }))
}

function parsePin (pin, options) {
  const parsed = pinEngine(pin)
  const ids = new Set()
  for (const rule of parsed.rules) {
    if (ids.has(rule.id)) {
      const error = new Error(`duplicate rule id: ${rule.id}`)
      error.code = 'E-DUPLICATE-RULE'
      throw error
    }
    ids.add(rule.id)
  }
  const engine = verifyEngine(
    options.registryPath ?? DEFAULT_REGISTRY,
    parsed.engine.contract,
    options.assetsRoot ?? DEFAULT_ASSETS_ROOT,
  )
  const expectedEngine = normalizeHash(parsed.engine.engineArtifactHash, 'ENGINE-HASH')
  if (expectedEngine !== engine.engineArtifactHash.slice(7)) throw new Error('E-PIN-ENGINE-MISMATCH')
  return { parsed, engine, expectedEngine }
}

async function verifyAndLoad (vm, parsed, timeoutMs) {
  const decodedModules = parsed.modules.map((module) => {
    const source = decodeSourceBase64(module.sourceBase64)
    return { ...module, source }
  })
  const modulesDatum = `(${decodedModules.map(moduleDatum).join(' ')})`
  const pluginsDatum = `(${parsed.plugins.map((p) => schemeString(JSON.stringify(p))).map((s) => `(${s})`).join(' ')})`
  const ffiDatum = `(${parsed.ffi.map((f) => schemeString(JSON.stringify(f))).map((s) => `(${s})`).join(' ')})`

  const verified = []
  for (const [index, rule] of parsed.rules.entries()) {
    if (typeof rule.id !== 'string' || typeof rule.version !== 'string') throw new Error('E-PIN-RULE')
    const source = decodeSourceBase64(rule.sourceBase64)
    const request = `(request "pin-${index}" pin-verify (rule ${schemeString(rule.id)} ${schemeString(rule.version)} ${schemeString(source)} ${modulesDatum} ${pluginsDatum} ${ffiDatum} ${signatureDatum(rule.signature)}))`
    const raw = await vm.dispatch(request, timeoutMs)
    const response = JSON.parse(raw)
    if (!response.ok) throw new Error(`E-PIN-VERIFY:${response.error?.code || 'UNKNOWN'}`)
    const actual = response.value
    for (const field of ['treeHash', 'bundleHash', 'pluginEnvironmentHash', 'ffiEnvironmentHash', 'ruleHash']) {
      if (normalizeHash(rule[field], `RULE-${field}`) !== normalizeHash(actual[field], `ACTUAL-${field}`)) {
        throw new Error(`E-PIN-MISMATCH:${field}:${rule.id}`)
      }
    }
    verified.push({ id: rule.id, version: rule.version, ...actual })
  }

  const rawHash = (value, field) => {
    const raw = typeof value === 'string' && value.startsWith('sha256:') ? value.slice(7) : value
    if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`E-PIN-${field}`)
    return raw
  }
  const rulesDatum = `(${parsed.rules.map((rule) => {
    const source = decodeSourceBase64(rule.sourceBase64)
    return `(rule ${schemeString(rule.id)} ${schemeString(rule.version)} ${schemeString(source)} ${signatureDatum(rule.signature)} ${schemeString(rawHash(rule.treeHash, 'TREE'))} ${schemeString(rawHash(rule.bundleHash, 'BUNDLE'))} ${schemeString(rawHash(rule.pluginEnvironmentHash, 'PLUGIN'))} ${schemeString(rawHash(rule.ffiEnvironmentHash, 'FFI'))} ${schemeString(rawHash(rule.ruleHash, 'RULE'))})`
  }).join(' ')})`
  const loadRequest = `(request "pin-load" pin-load (pin ${pluginsDatum} ${ffiDatum} ${modulesDatum} ${rulesDatum} ${schemeString(vm.bridgeToken ?? '')}))`
  const loadRaw = await vm.dispatch(loadRequest, timeoutMs)
  const loadResponse = JSON.parse(loadRaw)
  if (!loadResponse.ok || loadResponse.value?.loaded !== true || loadResponse.value?.registry !== parsed.rules.length) {
    throw new Error(`E-PIN-LOAD:${loadResponse.error?.code || 'UNKNOWN'}:${loadRaw}`)
  }
  return { verified, decodedModules }
}

export async function loadSchemeV2Pin (pin, options = {}) {
  const { parsed, engine, expectedEngine } = parsePin(pin, options)
  const timeoutMs = options.timeoutMs ?? 5000
  const vm = new CvmClient({ assetDir: engine.assetsDir })
  try {
    const { verified, decodedModules } = await verifyAndLoad(vm, parsed, timeoutMs)
    return {
      ok: true,
      metadataOnly: true,
      project: parsed.project,
      engine: { contract: parsed.engine.contract, engineArtifactHash: `sha256:${expectedEngine}` },
      rules: verified,
      modules: decodedModules.map((m) => ({ name: m.name })),
      loaded: true,
      plugins: parsed.plugins.length,
      ffi: parsed.ffi.length,
    }
  } finally {
    await vm.close()
  }
}

export class SchemeV2Runtime {
  static async open (pin, options = {}) {
    const { parsed, engine, expectedEngine } = parsePin(pin, options)
    if (parsed.plugins.length > 0) {
      const error = new Error('scheme v2 production runtime does not load project plugins yet')
      error.code = 'E-V2-PLUGIN-UNSUPPORTED'
      throw error
    }
    if (parsed.ffi.length > 0 && (!options.ffi || typeof options.ffi.call !== 'function')) {
      const error = new Error('scheme v2 pin declares FFI but no explicit host allowlist was supplied')
      error.code = 'E-V2-FFI-UNSUPPORTED'
      throw error
    }
    if (parsed.ffi.length === 0 && options.ffi) {
      const error = new Error('scheme v2 pin does not declare FFI')
      error.code = 'E-V2-FFI-UNDECLARED'
      throw error
    }
    const timeoutMs = options.timeoutMs ?? 5000
    const ffiTargets = parsed.ffi
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.target))
      .filter((value) => typeof value === 'string' && value.length > 0)
    const vm = new CvmClient({
      assetDir: engine.assetsDir,
      ffi: options.ffi ?? null,
      ffiTimeoutMs: options.ffiTimeoutMs ?? 1000,
      ffiTargets,
    })
    try {
      const { verified, decodedModules } = await verifyAndLoad(vm, parsed, timeoutMs)
      return new SchemeV2Runtime({
        vm,
        parsed,
        engine,
        expectedEngine,
        timeoutMs,
        rules: verified,
        modules: decodedModules,
      })
    } catch (error) {
      await vm.close()
      throw error
    }
  }

  constructor ({ vm, parsed, engine, expectedEngine, timeoutMs, rules, modules }) {
    this.vm = vm
    this.parsed = parsed
    this.engine = engine
    this.expectedEngine = expectedEngine
    this.timeoutMs = timeoutMs
    this.rules = rules
    this.modules = modules
    this.closed = false
    this.ffiSeq = 0
  }

  async call (ruleId, { procedure = 'entry', args = [] } = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    if (typeof ruleId !== 'string' || ruleId.length === 0) throw new Error('E-RULE-ID')
    if (typeof procedure !== 'string' || procedure.length === 0) throw new Error('E-RULE-PROCEDURE')
    if (!Array.isArray(args)) throw new Error('E-RULE-ARGS')
    const verified = this.rules.find((rule) => rule.id === ruleId)
    if (!verified) {
      const error = new Error(`unknown rule: ${ruleId}`)
      error.code = 'E-RULE-ID'
      throw error
    }
    const request = `(request "pin-call" pin-call (call ${schemeString(ruleId)} ${schemeString(procedure)} (${args.map(schemeValue).join(' ')})))`
    this.vm.currentRuleHash = String(verified.ruleHash)
    let raw
    try {
      raw = await this.vm.dispatch(request, timeoutMs)
    } finally {
      this.vm.currentRuleHash = null
    }
    const response = JSON.parse(raw)
    if (!response.ok) {
      const error = new Error(`scheme v2 rule failed: ${response.error?.code || 'E-RULE-ERROR'}`)
      error.code = response.error?.code || 'E-RULE-ERROR'
      throw error
    }
    return response.value
  }

  async ffiCall (target, args = [], timeoutMs = this.timeoutMs) {
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    if (this.parsed.ffi.length === 0 || !this.vm.ffi) {
      const error = new Error('scheme v2 pin does not declare FFI')
      error.code = 'E-V2-FFI-UNDECLARED'
      throw error
    }
    if (typeof target !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_-]*$/.test(target)) {
      throw new Error('E-FFI-TARGET')
    }
    if (!Array.isArray(args)) throw new Error('E-FFI-ARGS')
    const ruleHash = '@host'
    const rid = `ffi-${++this.ffiSeq}-${randomUUID()}`
    const request = `(request "ffi" ffi-call ${schemeString(rid)} "ffi" ${schemeString(ruleHash)} ${schemeString(target)} (${args.map(schemeValue).join(' ')}) ${schemeString(this.vm.bridgeToken)})`
    this.vm.currentRuleHash = ruleHash
    let raw
    try {
      raw = await this.vm.dispatch(request, timeoutMs)
    } finally {
      this.vm.currentRuleHash = null
    }
    const response = JSON.parse(raw)
    if (!response.ok) {
      const error = new Error(`scheme v2 ffi failed: ${response.error?.code || 'E-FFI-HOST'}`)
      error.code = response.error?.code || 'E-FFI-HOST'
      throw error
    }
    return response.value
  }

  async close () {
    if (this.closed) return
    this.closed = true
    await this.vm.close()
  }
}
