import { readFileSync, writeFileSync } from 'node:fs'

const [, , inputPath, outputPath] = process.argv
if (!inputPath || !outputPath) {
  console.error('usage: node migrate-v1-v2.mjs <v1-pin-rules.json> <report.json>')
  process.exit(2)
}

const input = JSON.parse(readFileSync(inputPath, 'utf8'))
const rules = Array.isArray(input)
  ? input
  : (Array.isArray(input.rules)
      ? input.rules
      : Object.entries(input)
        .filter(([name, value]) => name !== 'version' && value && typeof value === 'object' && !Array.isArray(value))
        .map(([name, rule]) => ({ name, ...rule })))

const report = rules.map((rule) => {
  const name = rule.name || rule.id || '(unnamed)'
  const blockers = []
  if (!rule.sourceBase64) blockers.push('v1-ast-is-not-scheme-source')
  else blockers.push('source-needs-behavioral-equivalence-review')
  if (!rule.signature || (!Array.isArray(rule.signature.inputs) && !Array.isArray(rule.signature.args))) {
    blockers.push('signature-needs-human-mapping')
  }
  if (!rule.pluginEnvironmentHash) blockers.push('plugin-environment-unresolved')
  if (!rule.ffiEnvironmentHash) blockers.push('ffi-environment-unresolved')
  if (!rule.engine) blockers.push('engine-contract-not-declared')
  return {
    name,
    id: rule.id || name,
    version: String(rule.version || ''),
    v1SourceKind: rule.sourceBase64 ? 'source-base64' : (rule.source ? 'ast' : 'unknown'),
    v2Status: 'manual-confirmation-required',
    blockers: [...new Set(blockers)],
    v1Hash: rule.ruleHash || null,
    v2Hashes: null,
    requiresHumanConfirmation: true,
  }
})

const result = {
  schema: 'dsh-migration-report/v1',
  source: inputPath,
  generatedAt: new Date().toISOString(),
  count: report.length,
  rules: report,
  automaticRewrite: false,
  v2DefaultEnabled: false,
}
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ count: result.count, output: outputPath, automaticRewrite: false }))
