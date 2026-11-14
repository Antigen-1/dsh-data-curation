import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { CvmClient } from './client.js'
import { CvmSupervisor } from './supervisor.js'
import {
  decodeSourceBase64,
  parseProjectLibraryName,
  parseVersionList,
  pinEngine,
  projectLibraryName,
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

function subjectKey (kind, id, version) {
  return `${kind}\u0000${id}\u0000${version.join('.')}`
}

function normalizeFfiModules (ffiModules) {
  if (ffiModules === undefined || ffiModules === null) return null
  if (typeof ffiModules !== 'object' || Array.isArray(ffiModules)) {
    throw Object.assign(new Error('ffiModules must be an object'), { code: 'E-FFI-MODULE' })
  }
  const normalized = Object.create(null)
  for (const [namespace, value] of Object.entries(ffiModules)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(namespace)) {
      throw Object.assign(new Error(`invalid FFI module namespace: ${namespace}`), { code: 'E-FFI-MODULE' })
    }
    let url
    try {
      url = value instanceof URL ? value : new URL(value)
    } catch {
      throw Object.assign(new Error(`invalid FFI module URL: ${namespace}`), { code: 'E-FFI-MODULE' })
    }
    if (url.protocol !== 'file:') {
      throw Object.assign(new Error(`FFI module must use a file URL: ${namespace}`), { code: 'E-FFI-MODULE' })
    }
    normalized[namespace] = url.href
  }
  return normalized
}

function assertFfiModuleCoverage (entries, ffiModules) {
  const required = new Set(entries.map((entry) => entry.id.split('.')[0]))
  for (const namespace of required) {
    if (!ffiModules || !ffiModules[namespace]) {
      throw Object.assign(new Error(`ffiModules is missing namespace: ${namespace}`), { code: 'E-FFI-MODULE' })
    }
  }
}

function buildFfiBindings (parsed, verified, pluginSubjects, programSubjects) {  const byKey = new Map()
  for (const rule of verified) {
    byKey.set(subjectKey('rule', rule.id, rule.version), normalizeHash(rule.ruleHash, 'FFI-RULE'))
  }
  for (const entry of pluginSubjects ?? []) {
    byKey.set(subjectKey('plugin', entry.id, entry.version), normalizeHash(entry.subject, 'FFI-PLUGIN'))
  }
  for (const entry of programSubjects ?? []) {
    byKey.set(subjectKey('program', entry.id, entry.version), normalizeHash(entry.subject, 'FFI-PROGRAM'))
  }

  const bindings = new Map()
  for (const entry of parsed.ffi) {
    for (const subject of entry.subjects) {
      const hash = byKey.get(subjectKey(subject.kind, subject.id, subject.version))
      if (!hash) throw new Error('E-PIN-FFI-BINDING')
      if (!bindings.has(hash)) bindings.set(hash, new Set())
      bindings.get(hash).add(entry.id)
    }
  }
  return bindings
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
  const version = parseVersionList(module.version, 'MODULE-VERSION')
  const parsed = parseProjectLibraryName(module.name)
  if (!parsed || parsed.kind !== 'lib') throw new Error('E-PIN-MODULE')
  return `(${projectLibraryName('lib', parsed.id, version)} (${version.join(' ')}) ${schemeString(decodeSourceBase64(module.sourceBase64))})`
}

const MAX_PLUGIN_SOURCE_BYTES = 1024 * 1024

function moduleNames (parsed) {
  return parsed.modules.map((module) => ({ name: module.name, version: module.version }))
}

export function readPluginFiles (parsed, options) {
  if (parsed.plugins.length === 0) return { sources: new Map(), projectFiles: [] }
  const projectRoot = resolve(options.projectRoot ?? process.cwd())
  const schemeRoot = join(projectRoot, 'rules', 'scheme')
  const realSchemeRoot = realpathSync(schemeRoot)
  const prefix = `${realSchemeRoot}${sep}`
  const sources = new Map()
  const projectFiles = []
  let pluginBytes = 0
  for (const plugin of parsed.plugins) {
    const absolute = resolve(schemeRoot, plugin.path)
    if (absolute !== schemeRoot && !absolute.startsWith(`${schemeRoot}${sep}`)) {
      throw new Error(`E-PIN-PLUGIN-PATH:${plugin.id}`)
    }
    const stats = lstatSync(absolute)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`E-PIN-PLUGIN-FILE:${plugin.id}`)
    const real = realpathSync(absolute)
    if (!real.startsWith(prefix)) throw new Error(`E-PIN-PLUGIN-ESCAPE:${plugin.id}`)
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    const fd = openSync(real, flags)
    let bytes
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile()) throw new Error(`E-PIN-PLUGIN-FILE:${plugin.id}`)
      bytes = readFileSync(fd)
    } finally {
      closeSync(fd)
    }
    pluginBytes += bytes.length
    if (bytes.length > MAX_PLUGIN_SOURCE_BYTES || pluginBytes > MAX_PLUGIN_SOURCE_BYTES) {
      throw new Error(`E-PIN-TOO-LARGE:plugin:${plugin.id}`)
    }
    let source
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`E-PIN-PLUGIN-UTF8:${plugin.id}`)
    }
    if (source.includes('\u0000')) throw new Error(`E-PIN-PLUGIN-NUL:${plugin.id}`)
    sources.set(`${plugin.kind}:${plugin.id}:${plugin.version.join('.')}`, source)
    projectFiles.push({
      path: `/project/rules/scheme/${plugin.path}`,
      content: source,
      readonly: true,
    })
  }
  return { sources, projectFiles }
}

function pluginDatum (plugin, source) {
  const version = parseVersionList(plugin.version, 'PLUGIN-VERSION')
  const treeHash = typeof plugin.treeHash === 'string' && plugin.treeHash.startsWith('sha256:')
    ? plugin.treeHash.slice(7)
    : plugin.treeHash
  const exports = plugin.kind === 'library' ? plugin.exports : []
  const exportDatum = `(${exports.map((name) => schemeSymbol(name)).join(' ')})`
  return `(plugin ${schemeString(plugin.id)} (${version.join(' ')}) ${schemeString(plugin.kind)} ${schemeString(plugin.path)} ${schemeString(treeHash)} ${exportDatum} ${schemeString(source)})`
}

function canonicalFfi (entry) {
  const subjects = entry.subjects
    .map((subject) => ({
      kind: subject.kind,
      id: subject.id,
      version: [...subject.version],
    }))
    .sort((left, right) => {
      const leftKey = `${left.kind}\u0000${left.id}\u0000${left.version.join('.')}`
      const rightKey = `${right.kind}\u0000${right.id}\u0000${right.version.join('.')}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  return JSON.stringify({ id: entry.id, subjects })
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
  const pluginInputs = readPluginFiles(parsed, options)
  return { parsed, engine, expectedEngine, pluginInputs }
}

const MAX_PIN_REQUEST_BYTES = 64 * 1024 * 1024

function assertSupportedPlatform () {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isInteger(major) || major < 24) {
    const error = new Error('scheme v2 requires Node.js 24 or newer')
    error.code = 'E-UNSUPPORTED-PLATFORM'
    throw error
  }
}

async function verifyAndLoad (vm, parsed, timeoutMs, pluginInputs, load = true) {
  const decodedModules = parsed.modules.map((module) => {
    const source = decodeSourceBase64(module.sourceBase64)
    return { ...module, source }
  })
  const modulesDatum = `(${decodedModules.map(moduleDatum).join(' ')})`
  const pluginsDatum = `(${parsed.plugins.map((plugin) => pluginDatum(
    plugin,
    pluginInputs.sources.get(`${plugin.kind}:${plugin.id}:${plugin.version.join('.')}`),
  )).join(' ')})`
  const ffiDatum = `(${parsed.ffi.map(canonicalFfi).map((f) => schemeString(f)).map((s) => `(${s})`).join(' ')})`

  const verified = []
  for (const [index, rule] of parsed.rules.entries()) {
    if (typeof rule.id !== 'string') throw new Error('E-PIN-RULE')
    const version = parseVersionList(rule.version, 'RULE-VERSION')
    const source = decodeSourceBase64(rule.sourceBase64)
    const request = `(request "pin-${index}" pin-verify (rule ${schemeString(rule.id)} (${version.join(' ')}) ${schemeString(source)} ${modulesDatum} ${pluginsDatum} ${ffiDatum} ${signatureDatum(rule.signature)}))`
    if (Buffer.byteLength(request, 'utf8') > MAX_PIN_REQUEST_BYTES) throw new Error('E-PIN-TOO-LARGE')
    const raw = await vm.dispatch(request, timeoutMs)
    const response = JSON.parse(raw)
    if (!response.ok) throw new Error(`E-PIN-VERIFY:${response.error?.code || 'UNKNOWN'}`)
    const actual = response.value
    for (const field of ['treeHash', 'bundleHash', 'pluginEnvironmentHash', 'ffiEnvironmentHash', 'ruleHash']) {
      if (normalizeHash(rule[field], `RULE-${field}`) !== normalizeHash(actual[field], `ACTUAL-${field}`)) {
        throw new Error(`E-PIN-MISMATCH:${field}:${rule.id}`)
      }
    }
    verified.push({ id: rule.id, version, ...actual })
  }

  if (!load) {
    return { verified, decodedModules, pluginSubjects: [], programSubjects: [] }
  }

  const rawHash = (value, field) => {
    const raw = typeof value === 'string' && value.startsWith('sha256:') ? value.slice(7) : value
    if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`E-PIN-${field}`)
    return raw
  }
  const rulesDatum = `(${parsed.rules.map((rule) => {
    const version = parseVersionList(rule.version, 'RULE-VERSION')
    const source = decodeSourceBase64(rule.sourceBase64)
    return `(rule ${schemeString(rule.id)} (${version.join(' ')}) ${schemeString(source)} ${signatureDatum(rule.signature)} ${schemeString(rawHash(rule.treeHash, 'TREE'))} ${schemeString(rawHash(rule.bundleHash, 'BUNDLE'))} ${schemeString(rawHash(rule.pluginEnvironmentHash, 'PLUGIN'))} ${schemeString(rawHash(rule.ffiEnvironmentHash, 'FFI'))} ${schemeString(rawHash(rule.ruleHash, 'RULE'))})`
  }).join(' ')})`
  const loadRequest = `(request "pin-load" pin-load (pin ${pluginsDatum} ${ffiDatum} ${modulesDatum} ${rulesDatum} ${schemeString(vm.bridgeToken ?? '')}))`
  if (Buffer.byteLength(loadRequest, 'utf8') > MAX_PIN_REQUEST_BYTES) throw new Error('E-PIN-TOO-LARGE')
  const loadRaw = await vm.dispatch(loadRequest, timeoutMs)
  const loadResponse = JSON.parse(loadRaw)
  if (!loadResponse.ok || loadResponse.value?.loaded !== true || loadResponse.value?.registry !== parsed.rules.length) {
    throw new Error(`E-PIN-LOAD:${loadResponse.error?.code || 'UNKNOWN'}:${loadRaw}`)
  }
  return {
    verified,
    decodedModules,
    pluginSubjects: loadResponse.value?.subjects ?? [],
    programSubjects: loadResponse.value?.programSubjects ?? [],
  }
}

export async function loadSchemeV2Pin (pin, options = {}) {
  assertSupportedPlatform()
  const { parsed, engine, expectedEngine, pluginInputs } = parsePin(pin, options)
  const timeoutMs = options.timeoutMs ?? 5000
  const vm = new CvmClient({ assetDir: engine.assetsDir, projectFiles: pluginInputs.projectFiles })
  try {
    const { verified, decodedModules } = await verifyAndLoad(vm, parsed, timeoutMs, pluginInputs, false)
    return {
      ok: true,
      metadataOnly: true,
      project: parsed.project,
      engine: { contract: parsed.engine.contract, engineArtifactHash: `sha256:${expectedEngine}` },
      rules: verified,
      modules: decodedModules.map((m) => ({ name: m.name })),
      loaded: false,
      plugins: parsed.plugins.length,
      programs: parsed.plugins.filter((plugin) => plugin.kind === 'program').length,
      ffi: parsed.ffi.length,
    }
  } finally {
    await vm.close()
  }
}

export class SchemeV2Runtime {
  static async open (pin, options = {}) {
    assertSupportedPlatform()
    const { parsed, engine, expectedEngine, pluginInputs } = parsePin(pin, options)
    if (options.ffi !== undefined && options.ffi !== null) {
      const error = new Error('the public ffi.call closure is removed; use ffiModules')
      error.code = 'E-FFI-MODULES-REQUIRED'
      throw error
    }
    const ffiModules = normalizeFfiModules(options.ffiModules)
    if (parsed.ffi.length > 0 && !ffiModules) {
      const error = new Error('scheme v2 pin declares FFI but no ffiModules were supplied')
      error.code = 'E-FFI-MODULE-REQUIRED'
      throw error
    }
    if (parsed.ffi.length === 0 && ffiModules) {
      const error = new Error('scheme v2 pin does not declare FFI')
      error.code = 'E-V2-FFI-UNDECLARED'
      throw error
    }
    if (parsed.ffi.length > 0) assertFfiModuleCoverage(parsed.ffi, ffiModules)
    const timeoutMs = options.timeoutMs ?? 5000
    const ffiTargets = parsed.ffi.map((entry) => entry.id)
    const supervised = options.supervised === true
    const vm = supervised
      ? new CvmSupervisor({
          ...options,
          assetDir: engine.assetsDir,
          projectFiles: pluginInputs.projectFiles,
          ffiModules,
        })
      : new CvmClient({
          assetDir: engine.assetsDir,
          projectFiles: pluginInputs.projectFiles,
          ffiModules,
          ffiTimeoutMs: options.ffiTimeoutMs ?? 1000,
          ffiTargets,
        })
    try {
      if (!supervised && ffiModules) await vm.preloadFfiModules()
      const { verified, decodedModules, pluginSubjects, programSubjects } = await verifyAndLoad(vm, parsed, timeoutMs, pluginInputs)
      const bindings = buildFfiBindings(parsed, verified, pluginSubjects, programSubjects)
      if (typeof vm.setFfiBindings === 'function') vm.setFfiBindings(bindings)
      else vm.ffiBindings = bindings
      let programs = []
      let dynamicRules = []
      if (parsed.plugins.some((plugin) => plugin.kind === 'program')) {
        const programSubjectsMap = new Map((programSubjects ?? []).map((entry) => [entry.subject, entry.id]))
        if (typeof vm.setProgramAllowlist === 'function') {
          vm.setProgramAllowlist(new Set((programSubjects ?? []).map((entry) => entry.subject)), programSubjectsMap)
        } else {
          vm.allowedRuleHashes = new Set((programSubjects ?? []).map((entry) => entry.subject))
          vm.programSubjects = programSubjectsMap
        }
        let runRaw
        try {
          runRaw = await vm.dispatch('(request "pin-run-programs" pin-run-programs)', timeoutMs)
        } finally {
          if (typeof vm.setProgramAllowlist === 'function') vm.setProgramAllowlist(new Set(), new Map())
          else {
            vm.allowedRuleHashes = new Set()
            vm.programSubjects = new Map()
          }
        }
        const runResponse = JSON.parse(runRaw)
        if (!runResponse.ok) {
          const error = new Error(`scheme v2 program failed: ${runResponse.error?.code || 'E-PLUGIN-ERROR'}`)
          error.code = runResponse.error?.code || 'E-PLUGIN-ERROR'
          throw error
        }
        programs = runResponse.value?.programs ?? []
        dynamicRules = runResponse.value?.rules ?? []
      }
      return new SchemeV2Runtime({
        vm,
        parsed,
        engine,
        expectedEngine,
        timeoutMs,
        rules: verified,
        modules: decodedModules,
        programs,
        dynamicRules,
        pluginInputs,
        pluginSubjects,
        programSubjects,
        onEvent: options.onEvent,
      })
    } catch (error) {
      await vm.close()
      if (error.code === 'E-VM-EXIT') {
        const exitError = new Error(`scheme v2 program exited: ${error.exitCode}`)
        exitError.code = 'E-PLUGIN-EXIT'
        exitError.exitCode = error.exitCode
        throw exitError
      }
      throw error
    }
  }

  constructor ({ vm, parsed, engine, expectedEngine, timeoutMs, rules, modules, programs, dynamicRules, pluginInputs, pluginSubjects, programSubjects, onEvent }) {
    this.vm = vm
    this.parsed = parsed
    this.engine = engine
    this.expectedEngine = expectedEngine
    this.timeoutMs = timeoutMs
    this.pluginInputs = pluginInputs
    this.pluginSubjects = pluginSubjects ?? []
    this.programSubjects = programSubjects ?? []
    this.staticRules = rules
    this.modules = modules
    this.plugins = parsed.plugins
    this.programs = programs ?? []
    this.dynamicRules = dynamicRules ?? []
    this.rules = [
      ...(rules ?? []).map((rule) => ({ ...rule, source: 'static' })),
      ...(dynamicRules ?? []).map((rule) => ({ ...rule, source: 'program' })),
    ]
    this.closed = false
    this.busy = false
    this.callCount = 0
    this.errorCount = 0
    this.gcCount = 0
    this.restarts = 0
    this.errorCodes = {}
    this.onEvent = typeof onEvent === 'function' ? onEvent : null
    this.latencyWindowMs = 30000
    this.latencies = []
  }

  _emit (type, detail = {}) {
    if (!this.onEvent) return
    try {
      this.onEvent({ ts: new Date().toISOString(), type, ...detail })
    } catch {
      // Logging must never change runtime behavior.
    }
  }

  _countError (code) {
    const normalized = code || 'E-UNKNOWN'
    this.errorCount += 1
    this.errorCodes[normalized] = (this.errorCodes[normalized] ?? 0) + 1
    this._emit('error', { code: normalized })
  }

  _beginCall () {
    if (this.busy) {
      const error = new Error('scheme v2 runtime already has an in-flight call')
      error.code = 'E-VM-BUSY'
      throw error
    }
    this.busy = true
  }

  _recordLatency (started) {
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    this.latencies.push({ at: Date.now(), ms: elapsed })
    if (this.latencies.length > 10000) this.latencies.shift()
  }

  _endCall () {
    this.busy = false
    this.vm.currentRuleHash = null
    this.vm.currentSubjectKind = null
    this.vm.currentPluginId = null
  }

  async restart () {
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    if (!(this.vm instanceof CvmSupervisor)) {
      const error = new Error('restart is only available for supervised runtimes')
      error.code = 'E-VM-RESTART-UNSUPPORTED'
      throw error
    }
    this._beginCall()
    try {
      await this.vm.restart()
      const { verified, decodedModules, pluginSubjects, programSubjects } = await verifyAndLoad(
        this.vm, this.parsed, this.timeoutMs, this.pluginInputs)
      const bindings = buildFfiBindings(this.parsed, verified, pluginSubjects, programSubjects)
      if (typeof this.vm.setFfiBindings === 'function') this.vm.setFfiBindings(bindings)
      else this.vm.ffiBindings = bindings
      let programs = []
      let dynamicRules = []
      if (this.parsed.plugins.some((plugin) => plugin.kind === 'program')) {
        const programSubjectsMap = new Map((programSubjects ?? []).map((entry) => [entry.subject, entry.id]))
        if (typeof this.vm.setProgramAllowlist === 'function') {
          this.vm.setProgramAllowlist(new Set((programSubjects ?? []).map((entry) => entry.subject)), programSubjectsMap)
        } else {
          this.vm.allowedRuleHashes = new Set((programSubjects ?? []).map((entry) => entry.subject))
          this.vm.programSubjects = programSubjectsMap
        }
        let runRaw
        try {
          runRaw = await this.vm.dispatch('(request "pin-run-programs" pin-run-programs)', this.timeoutMs)
        } finally {
          if (typeof this.vm.setProgramAllowlist === 'function') this.vm.setProgramAllowlist(new Set(), new Map())
          else {
            this.vm.allowedRuleHashes = new Set()
            this.vm.programSubjects = new Map()
          }
        }
        const runResponse = JSON.parse(runRaw)
        if (!runResponse.ok) {
          const error = new Error(`scheme v2 program failed: ${runResponse.error?.code || 'E-PLUGIN-ERROR'}`)
          error.code = runResponse.error?.code || 'E-PLUGIN-ERROR'
          throw error
        }
        programs = runResponse.value?.programs ?? []
        dynamicRules = runResponse.value?.rules ?? []
      }
      this.staticRules = verified
      this.modules = decodedModules
      this.pluginSubjects = pluginSubjects
      this.programSubjects = programSubjects
      this.programs = programs
      this.dynamicRules = dynamicRules
      this.rules = [
        ...verified.map((rule) => ({ ...rule, source: 'static' })),
        ...dynamicRules.map((rule) => ({ ...rule, source: 'program' })),
      ]
      this.closed = false
      this.restarts += 1
      this._emit('restart')
    } catch (error) {
      this.closed = true
      await this.vm.close()
      throw error
    } finally {
      this._endCall()
    }
  }

  async call (ruleId, argsOrOptions = [], optionsOrTimeout = this.timeoutMs) {
    let procedure = 'entry'
    let args = []
    let timeoutMs = this.timeoutMs
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions
      if (typeof optionsOrTimeout === 'number') timeoutMs = optionsOrTimeout
      else if (optionsOrTimeout && typeof optionsOrTimeout === 'object') {
        timeoutMs = optionsOrTimeout.timeoutMs ?? this.timeoutMs
      }
    } else if (argsOrOptions && typeof argsOrOptions === 'object') {
      procedure = argsOrOptions.procedure ?? 'entry'
      args = argsOrOptions.args ?? []
      if (typeof optionsOrTimeout === 'number') timeoutMs = optionsOrTimeout
      else if (optionsOrTimeout && typeof optionsOrTimeout === 'object') {
        timeoutMs = optionsOrTimeout.timeoutMs ?? this.timeoutMs
      }
    } else if (argsOrOptions !== undefined) {
      throw new Error('E-RULE-ARGS')
    }
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    if (typeof ruleId !== 'string' || ruleId.length === 0) throw new Error('E-RULE-ID')
    if (typeof procedure !== 'string' || procedure.length === 0) throw new Error('E-RULE-PROCEDURE')
    if (!Array.isArray(args)) throw new Error('E-RULE-ARGS')
    const verified = this.staticRules.find((rule) => rule.id === ruleId)
    if (!verified) {
      const error = new Error(`unknown rule: ${ruleId}`)
      error.code = 'E-RULE-ID'
      throw error
    }
    const request = `(request "pin-call" pin-call (call ${schemeString(ruleId)} ${schemeString(procedure)} (${args.map(schemeValue).join(' ')})))`
    this._beginCall()
    this.vm.currentRuleHash = String(verified.ruleHash)
    this.vm.currentSubjectKind = 'rule'
    this.vm.currentPluginId = null
    this.callCount += 1
    const started = process.hrtime.bigint()
    let raw
    try {
      raw = await this.vm.dispatch(request, timeoutMs)
    } catch (error) {
      this._countError(error.code || 'E-VM-ERROR')
      throw error
    } finally {
      this._recordLatency(started)
      this._endCall()
    }
    const response = JSON.parse(raw)
    if (!response.ok) {
      const code = response.error?.code || 'E-RULE-ERROR'
      this._countError(code)
      const error = new Error(`scheme v2 rule failed: ${code}`)
      error.code = code
      throw error
    }
    return response.value
  }

  async callPlugin (pluginId, version, procedure = 'entry', args = [], options = {}) {
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    if (typeof pluginId !== 'string' || pluginId.length === 0) throw new Error('E-PLUGIN-ID')
    if (!Array.isArray(version) || version.length === 0 ||
        version.some((part) => !Number.isSafeInteger(part) || part < 0)) {
      throw new Error('E-PLUGIN-VERSION')
    }
    if (typeof procedure !== 'string' || procedure.length === 0) throw new Error('E-PLUGIN-PROCEDURE')
    if (!Array.isArray(args)) throw new Error('E-PLUGIN-ARGS')
    const plugin = this.plugins.find((entry) =>
      entry.id === pluginId &&
      Array.isArray(entry.version) &&
      entry.version.length === version.length &&
      entry.version.every((part, index) => part === version[index]))
    if (!plugin) {
      const error = new Error(`unknown plugin: ${pluginId} ${version.join('.')}`)
      error.code = 'E-PLUGIN-ID'
      throw error
    }
    if (plugin.kind !== 'library') {
      const error = new Error(`plugin is not callable: ${pluginId}`)
      error.code = 'E-PLUGIN-NOT-CALLABLE'
      throw error
    }
    const subjectEntry = this.pluginSubjects.find((entry) =>
      entry.id === plugin.id &&
      Array.isArray(entry.version) &&
      entry.version.length === version.length &&
      entry.version.every((part, index) => part === version[index]))
    if (!subjectEntry || typeof subjectEntry.subject !== 'string') {
      const error = new Error(`plugin subject is unavailable: ${pluginId} ${version.join('.')}`)
      error.code = 'E-PLUGIN-SUBJECT'
      throw error
    }
    const subject = subjectEntry.subject
    const request = `(request "pin-plugin-call" pin-plugin-call (plugin-call ${schemeString(pluginId)} (${version.join(' ')}) ${schemeString(procedure)} (${args.map(schemeValue).join(' ')}) ${schemeString(subject)}))`
    this._beginCall()
    this.vm.currentRuleHash = subject
    this.vm.currentSubjectKind = 'plugin'
    this.vm.currentPluginId = plugin.id
    this.callCount += 1
    const started = process.hrtime.bigint()
    let raw
    try {
      raw = await this.vm.dispatch(request, options.timeoutMs ?? this.timeoutMs)
    } catch (error) {
      this._countError(error.code || 'E-VM-ERROR')
      throw error
    } finally {
      this._recordLatency(started)
      this._endCall()
    }
    const response = JSON.parse(raw)
    if (!response.ok) {
      const code = response.error?.code || 'E-PLUGIN-ERROR'
      this._countError(code)
      const error = new Error(`scheme v2 plugin failed: ${code}`)
      error.code = code
      throw error
    }
    return response.value
  }

  async callRule (ruleId, version, args = [], options = {}) {
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    if (typeof ruleId !== 'string' || ruleId.length === 0) {
      const error = new Error('E-RULE-ID')
      error.code = 'E-RULE-ID'
      throw error
    }
    if (!Array.isArray(version) || version.length === 0 ||
        version.some((part) => !Number.isSafeInteger(part) || part < 0)) {
      const error = new Error('E-RULE-VERSION')
      error.code = 'E-RULE-VERSION'
      throw error
    }
    if (!Array.isArray(args)) {
      const error = new Error('E-RULE-ARGS')
      error.code = 'E-RULE-ARGS'
      throw error
    }
    const entry = this.dynamicRules.find((rule) =>
      rule.id === ruleId &&
      Array.isArray(rule.version) &&
      rule.version.length === version.length &&
      rule.version.every((part, index) => part === version[index]))
    if (!entry) {
      const error = new Error(`unknown dynamic rule: ${ruleId} ${version.join('.')}`)
      error.code = 'E-RULE-NOT-LOADED'
      throw error
    }
    const request = `(request "pin-dynamic-call" pin-dynamic-call (dynamic-call ${schemeString(ruleId)} (${version.join(' ')}) (${args.map(schemeValue).join(' ')}) ${schemeString(entry.subject)}))`
    this._beginCall()
    // A dynamic rule acts with its owning program's FFI identity. The guest
    // still authenticates the call with the dynamic subject, but the
    // channel frame carries the program subject that owns the FFI grant.
    this.vm.currentRuleHash = entry.programSubject ?? entry.subject
    this.vm.currentSubjectKind = entry.programSubject ? 'program' : 'rule'
    this.vm.currentPluginId = null
    this.callCount += 1
    const started = process.hrtime.bigint()
    let raw
    try {
      raw = await this.vm.dispatch(request, options.timeoutMs ?? this.timeoutMs)
    } catch (error) {
      this._countError(error.code || 'E-VM-ERROR')
      throw error
    } finally {
      this._recordLatency(started)
      this._endCall()
    }
    const response = JSON.parse(raw)
    if (!response.ok) {
      const code = response.error?.code || 'E-RULE-ERROR'
      this._countError(code)
      const error = new Error(`scheme v2 dynamic rule failed: ${code}`)
      error.code = code
      throw error
    }
    return response.value
  }

  programResult (programId, version) {
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    if (typeof programId !== 'string' || programId.length === 0) throw new Error('E-PROGRAM-ID')
    if (!Array.isArray(version) || version.length === 0 ||
        version.some((part) => !Number.isSafeInteger(part) || part < 0)) {
      throw new Error('E-PROGRAM-VERSION')
    }
    const entry = this.programs.find((program) =>
      program.id === programId &&
      Array.isArray(program.version) &&
      program.version.length === version.length &&
      program.version.every((part, index) => part === version[index]))
    if (!entry) {
      const error = new Error(`unknown program: ${programId} ${version.join('.')}`)
      error.code = 'E-PROGRAM-ID'
      throw error
    }
    return entry.result
  }

  async gc (timeoutMs = this.timeoutMs) {
    if (this.closed) {
      const error = new Error('scheme v2 runtime is closed')
      error.code = 'E-VM-CLOSED'
      throw error
    }
    const result = await (async () => {
      this._beginCall()
      try {
        return await this.vm.gc(timeoutMs)
      } finally {
        this._endCall()
      }
    })()
    this.gcCount += 1
    return result
  }

  metrics () {
    const cutoff = Date.now() - this.latencyWindowMs
    const windowed = this.latencies.filter((sample) => sample.at >= cutoff)
    const sorted = windowed.map((sample) => sample.ms).sort((a, b) => a - b)
    const percentile = (p) => sorted.length === 0
      ? 0
      : Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(3))
    return {
      ...(this.vm.metrics() ?? {}),
      calls: this.callCount,
      errors: this.errorCount,
      errorCodes: { ...this.errorCodes },
      restarts: this.restarts,
      gcs: this.gcCount,
      latencyMs: {
        windowMs: this.latencyWindowMs,
        count: sorted.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
      },
      staticRules: this.staticRules.length,
      dynamicRules: this.dynamicRules.length,
      plugins: this.plugins.length,
      programs: this.programs.length,
    }
  }

  async close () {
    if (this.closed) return
    this.closed = true
    await this.vm.close()
  }
}
