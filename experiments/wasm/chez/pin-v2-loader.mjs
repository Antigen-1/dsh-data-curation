import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CvmClient } from './c-vm-client.mjs'
import {
  decodeSourceBase64,
  pinEngine,
  schemeString,
  verifyEngine,
} from './pin-v2-lib.mjs'

function normalizeHash (value, field) {
  if (typeof value !== 'string') throw new Error(`E-PIN-${field}`)
  const raw = value.startsWith('sha256:') ? value.slice(7) : value
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`E-PIN-${field}`)
  return raw
}

function signatureDatum (signature) {
  if (!signature || !Array.isArray(signature.inputs) || typeof signature.output !== 'string') {
    throw new Error('E-PIN-SIGNATURE')
  }
  const inputs = signature.inputs.map((x) => String(x)).join(' ')
  return `(signature (${inputs}) ${signature.output} ${signature.variadic === true ? '#t' : '#f'})`
}

function moduleDatum (module) {
  if (typeof module.name !== 'string' || typeof module.version !== 'string') {
    throw new Error('E-PIN-MODULE')
  }
  return `(${schemeString(module.name)} ${schemeString(module.version)} ${schemeString(decodeSourceBase64(module.sourceBase64))})`
}

export async function loadPinV2 ({
  pinPath,
  registryPath,
  assetsRoot,
  timeoutMs = 5000,
}) {
  const pin = pinEngine(JSON.parse(readFileSync(pinPath, 'utf8')))
  const engine = verifyEngine(registryPath, pin.engine.contract, assetsRoot)
  const expectedEngine = normalizeHash(pin.engine.engineArtifactHash, 'ENGINE-HASH')
  if (expectedEngine !== engine.engineArtifactHash.slice(7)) throw new Error('E-PIN-ENGINE-MISMATCH')

  const decodedModules = pin.modules.map((module) => {
    const source = decodeSourceBase64(module.sourceBase64)
    return { ...module, source }
  })
  const modulesDatum = `(${decodedModules.map(moduleDatum).join(' ')})`
  const pluginsDatum = `(${pin.plugins.map((p) => schemeString(JSON.stringify(p))).map((s) => `(${s})`).join(' ')})`
  const ffiDatum = `(${pin.ffi.map((f) => schemeString(JSON.stringify(f))).map((s) => `(${s})`).join(' ')})`

  const vm = new CvmClient({ assetDir: engine.assetsDir })
  const verified = []
  try {
    for (const [index, rule] of pin.rules.entries()) {
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
    const rulesDatum = `(${pin.rules.map((rule) => {
      const source = decodeSourceBase64(rule.sourceBase64)
      return `(rule ${schemeString(rule.id)} ${schemeString(rule.version)} ${schemeString(source)} ${signatureDatum(rule.signature)} ${schemeString(rawHash(rule.treeHash, 'TREE'))} ${schemeString(rawHash(rule.bundleHash, 'BUNDLE'))} ${schemeString(rawHash(rule.pluginEnvironmentHash, 'PLUGIN'))} ${schemeString(rawHash(rule.ffiEnvironmentHash, 'FFI'))} ${schemeString(rawHash(rule.ruleHash, 'RULE'))})`
    }).join(' ')})`
    const loadRequest = `(request "pin-load" pin-load (pin ${pluginsDatum} ${ffiDatum} ${modulesDatum} ${rulesDatum}))`
    const loadRaw = await vm.dispatch(loadRequest, timeoutMs)
    const loadResponse = JSON.parse(loadRaw)
    if (!loadResponse.ok || loadResponse.value?.loaded !== true || loadResponse.value?.registry !== pin.rules.length) {
      throw new Error(`E-PIN-LOAD:${loadResponse.error?.code || 'UNKNOWN'}:${loadRaw}`)
    }

    return {
      ok: true,
      project: pin.project,
      engine: { contract: pin.engine.contract, engineArtifactHash: `sha256:${expectedEngine}` },
      rules: verified,
      modules: decodedModules.map((m) => ({ name: m.name })),
      loaded: true,
    }
  } finally {
    await vm.close()
  }
}
