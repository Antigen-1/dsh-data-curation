// lib/rules/scheme/index.js — public Scheme frontend surface.
//
// The Scheme frontend is an additional authoring surface. Its persisted rule
// identity is always the lowered v1 JSON AST, never the Scheme source text.
export { readScheme, symbolName } from './reader.js'
export {
  Lowerer,
  createSchemeScope,
  lowerSchemeClosure,
  lowerSchemeDatum,
  lowerSchemeExpression,
  lowerSchemeRule,
  standardLibraryBindings,
} from './lower.js'
export { STANDARD_LIBRARY_SOURCE } from './stdlib.js'
export { compileSchemePredicate, compileSchemeRule } from './compile.js'
export {
  evaluateSchemeModule,
  loadSchemeRules,
  pinRulesFromDescriptors,
  registerRule,
} from './module.js'
