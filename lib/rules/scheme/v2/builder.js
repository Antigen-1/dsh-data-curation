import { fileURLToPath } from 'node:url'
import { CvmClient } from './client.js'
import {
  parseVersionList,
  pinEngine,
  projectLibraryName,
  schemeString,
  verifyEngine,
} from './pin-lib.js'

const DEFAULT_ASSETS_ROOT = fileURLToPath(new URL('../../../../assets/chez-wasm/', import.meta.url))
const DEFAULT_REGISTRY = `${DEFAULT_ASSETS_ROOT.replace(/[\\/]$/, '')}/engine-registry.json`
const ENGINE_CONTRACT = 'chez-wasm-c-10.4.1-v1'
const MAX_SOURCE_BYTES = 1024 * 1024

function fail (code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details) error.details = details
  throw error
}

function versionOf (value, field) {
  return parseVersionList(value, field)
}

function schemeSymbol (value) {
  if (typeof value !== 'string' || !/^[A-Za-z!$%&*/:<=>?^_~][A-Za-z0-9!$%&*/:<=>?^_~+\-.]*$/.test(value)) {
    fail('E-PIN-SIGNATURE', `invalid signature symbol: ${String(value)}`)
  }
  return value
}

function signatureDatum (signature) {
  if (!signature) return '#f'
  const spec = signature
  if (!spec || !Array.isArray(spec.inputs) || typeof spec.output !== 'string') {
    fail('E-PIN-SIGNATURE', 'rule signature must be { inputs, output, variadic? }')
  }
  const inputs = spec.inputs.map((x) => schemeSymbol(String(x))).join(' ')
  return `(signature (${inputs}) ${schemeSymbol(spec.output)} ${spec.variadic === true ? '#t' : '#f'})`
}

function canonicalFfi (entry) {
  const subjects = (entry.subjects ?? [])
    .map((subject) => ({
      kind: subject.kind,
      id: subject.id,
      version: [...versionOf(subject.version, 'FFI-SUBJECT-VERSION')],
    }))
    .sort((left, right) => {
      const leftKey = `${left.kind}\u0000${left.id}\u0000${left.version.join('.')}`
      const rightKey = `${right.kind}\u0000${right.id}\u0000${right.version.join('.')}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  return JSON.stringify({ id: entry.id, subjects })
}

function pluginPath (plugin, version) {
  if (plugin.kind === 'library') {
    return `lib/dsh/plugin/${plugin.id}/${version.join('.')}.sls`
  }
  const path = plugin.path ?? `programs/${plugin.id}/${version.join('.')}.scm`
  if (!path.startsWith('programs/') || !path.endsWith('.scm')) {
    fail('E-PIN-PLUGIN-PATH', `program plugin path must be under programs/*.scm: ${plugin.id}`, { pluginId: plugin.id, path })
  }
  return path
}

function pluginDatum (plugin) {
  const version = versionOf(plugin.version, 'PLUGIN-VERSION')
  const path = pluginPath(plugin, version)
  const exports = plugin.kind === 'library' ? (plugin.exports ?? []) : []
  const tree = String(plugin.treeHash).replace(/^sha256:/, '')
  return `(plugin ${schemeString(plugin.id)} (${version.join(' ')}) ${schemeString(plugin.kind)} ${schemeString(path)} ${schemeString(tree)} (${exports.join(' ')}) ${schemeString(plugin.source)})`
}

function moduleDatum (module) {
  const version = versionOf(module.version, 'MODULE-VERSION')
  return `(${projectLibraryName('lib', module.id, version)} (${version.join(' ')}) ${schemeString(module.source)})`
}

async function sourceHash (vm, source, timeoutMs) {
  if (typeof source !== 'string') fail('E-PIN-SOURCE', 'source must be a string')
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) fail('E-PIN-TOO-LARGE', 'source exceeds 1 MiB')
  const raw = await vm.dispatch(`(request "builder-hash" source-tree-hash ${schemeString(source)})`, timeoutMs)
  const response = JSON.parse(raw)
  if (!response.ok) fail(response.error?.code ?? 'E-SCHEME-HASH', raw)
  return `sha256:${response.value}`
}

/**
 * Hash one Scheme source file with the v2 canonical datum encoder.
 * This opens a short-lived VM and is intended for pin construction, not hot paths.
 */
export async function hashSchemeSource (source, options = {}) {
  const assetsRoot = options.assetsRoot ?? DEFAULT_ASSETS_ROOT
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY
  const engine = verifyEngine(registryPath, ENGINE_CONTRACT, assetsRoot)
  const vm = new CvmClient({ assetDir: engine.assetsDir, openTimeoutMs: options.openTimeoutMs ?? 10000 })
  try {
    return await sourceHash(vm, source, options.timeoutMs ?? 5000)
  } finally {
    await vm.close()
  }
}

/**
 * Build and validate a dsh-pin/v2 from source text.
 * Returns the same object shape accepted by SchemeV2Runtime.open.
 */
export async function buildSchemeV2Pin (input, options = {}) {
  if (!input || typeof input !== 'object') fail('E-PIN-SCHEMA', 'buildSchemeV2Pin requires an input object')
  const assetsRoot = options.assetsRoot ?? DEFAULT_ASSETS_ROOT
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY
  const engine = verifyEngine(registryPath, ENGINE_CONTRACT, assetsRoot)
  const timeoutMs = options.timeoutMs ?? 5000
  const modules = (input.modules ?? []).map((module) => ({
    ...module,
    id: module.id,
    version: versionOf(module.version, 'MODULE-VERSION'),
  }))
  const plugins = (input.plugins ?? []).map((plugin) => ({
    ...plugin,
    version: versionOf(plugin.version, 'PLUGIN-VERSION'),
    path: pluginPath(plugin, versionOf(plugin.version, 'PLUGIN-VERSION')),
  }))
  const ffi = (input.ffi ?? []).map((entry) => ({
    id: entry.id,
    subjects: (entry.subjects ?? []).map((subject) => ({
      kind: subject.kind,
      id: subject.id,
      version: versionOf(subject.version, 'FFI-SUBJECT-VERSION'),
    })),
  }))

  const vm = new CvmClient({ assetDir: engine.assetsDir, openTimeoutMs: options.openTimeoutMs ?? 10000 })
  try {
    const hashedPlugins = []
    for (const plugin of plugins) {
      hashedPlugins.push({ ...plugin, treeHash: await sourceHash(vm, plugin.source, timeoutMs) })
    }
    const modulesDatum = `(${modules.map(moduleDatum).join(' ')})`
    const pluginsDatum = `(${hashedPlugins.map(pluginDatum).join(' ')})`
    const ffiDatum = `(${ffi.map((entry) => `(${schemeString(canonicalFfi(entry))})`).join(' ')})`
    const rules = []
    for (const [index, rule] of (input.rules ?? []).entries()) {
      const version = versionOf(rule.version, 'RULE-VERSION')
      const signature = rule.signature ?? null
      const request = `(request "builder-rule-${index}" pin-verify (rule ${schemeString(rule.id)} (${version.join(' ')}) ${schemeString(rule.source)} ${modulesDatum} ${pluginsDatum} ${ffiDatum} ${signatureDatum(signature)}))`
      if (Buffer.byteLength(request, 'utf8') > 64 * 1024 * 1024) fail('E-PIN-TOO-LARGE', 'pin verify request exceeds 64 MiB')
      const raw = await vm.dispatch(request, timeoutMs)
      const response = JSON.parse(raw)
      if (!response.ok) {
        fail(response.error?.code ?? 'E-PIN-VERIFY', raw, { ruleId: rule.id })
      }
      const values = response.value
      const sourceBase64 = Buffer.from(rule.source, 'utf8').toString('base64')
      rules.push({
        id: rule.id,
        version,
        sourceEncoding: 'utf-8-base64',
        sourceBase64,
        treeHash: `sha256:${values.treeHash}`,
        bundleHash: `sha256:${values.bundleHash}`,
        ...(signature ? { signature } : {}),
        pluginEnvironmentHash: `sha256:${values.pluginEnvironmentHash}`,
        ffiEnvironmentHash: `sha256:${values.ffiEnvironmentHash}`,
        ruleHash: `sha256:${values.ruleHash}`,
      })
    }
    const pin = {
      schema: 'dsh-pin/v2',
      project: input.project ?? 'scheme-v2',
      engine: {
        contract: ENGINE_CONTRACT,
        engineArtifactHash: engine.engineArtifactHash,
      },
      modules: modules.map((module) => ({
        name: projectLibraryName('lib', module.id, versionOf(module.version, 'MODULE-VERSION')),
        version: module.version,
        sourceBase64: Buffer.from(module.source, 'utf8').toString('base64'),
      })),
      plugins: hashedPlugins.map((plugin) => ({
        id: plugin.id,
        version: plugin.version,
        kind: plugin.kind,
        path: plugin.path,
        treeHash: plugin.treeHash,
        ...(plugin.kind === 'library' ? { exports: [...(plugin.exports ?? [])] } : {}),
        capabilities: [],
      })),
      ffi,
      rules,
    }
    return pinEngine(pin)
  } finally {
    await vm.close()
  }
}

export { DEFAULT_ASSETS_ROOT, DEFAULT_REGISTRY, ENGINE_CONTRACT }
