// lib/normalize.js — conservative normalization of extracted cell values.
//
// Two modes:
//   safe    (default) unicode width, whitespace, a small punctuation set,
//           explicit cm/mm conversion, Chinese numerals in counting contexts,
//           and project-declared synonyms.
//   strict  only unicode width, whitespace and punctuation.
//
// Anything that could erase a real difference (region, lesion id, long/short
// diameter, in-procedure vs post-procedure, partial vs complete closure) is
// deliberately left alone.

const PUNCT = [
  [/\u3000/g, ' '],
  [/，/g, ','],
  [/；/g, ';'],
  [/：/g, ':'],
  [/（/g, '('],
  [/）/g, ')'],
  [/、/g, ','],
  [/。/g, '.'],
]

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function cnToNumber(word) {
  if (word === '十') return 10
  if (word.length === 1) return CN_DIGIT[word]
  if (word.length === 2 && word[0] === '十') return 10 + CN_DIGIT[word[1]]
  if (word.length === 2 && word[1] === '十') return CN_DIGIT[word[0]] * 10
  if (word.length === 3 && word[1] === '十') return CN_DIGIT[word[0]] * 10 + CN_DIGIT[word[2]]
  return undefined
}

/** Convert Chinese numerals that sit in a counting context: 两处 -> 2处, 十枚 -> 10枚. */
function convertCounters(s) {
  return s.replace(/([零一二两三四五六七八九十]{1,3})(?=\s*(?:处|个|枚|次|条|灶))/g, (m, word) => {
    const n = cnToNumber(word)
    return n === undefined ? m : String(n)
  })
}

/** Explicit unit conversion only: 1.2cm -> 12mm, 12 毫米 -> 12mm. */
function convertUnits(s) {
  let out = s.replace(/(\d+(?:\.\d+)?)\s*(?:cm|CM|Cm|厘米)(?![a-z])/g, (m, n) => {
    const mm = Number(n) * 10
    return `${Number.isInteger(mm) ? mm : mm.toFixed(1)}mm`
  })
  out = out.replace(/(\d+(?:\.\d+)?)\s*(?:mm|MM|Mm|毫米)(?![a-z])/g, (m, n) => `${n}mm`)
  return out
}

/** Expand {canonical: [aliases]} into {alias: canonical} for exact-match lookup. */
export function expandSynonyms(map) {
  const out = {}
  for (const [canonical, aliases] of Object.entries(map ?? {})) {
    if (typeof aliases === 'string') {
      out[aliases] = canonical
    } else if (Array.isArray(aliases)) {
      for (const alias of aliases) if (typeof alias === 'string') out[alias] = canonical
    }
  }
  return out
}

function applySynonyms(s, map) {
  if (!map || typeof map !== 'object') return s
  const hit = map[s]
  return typeof hit === 'string' ? hit : s
}

/**
 * @param {unknown} value raw cell text
 * @param {{mode?:'safe'|'strict', synonyms?:Record<string,string>, caseInsensitive?:boolean}} spec
 * @returns {string} normalized text ('' for null/undefined)
 */
export function normalizeValue(value, spec = {}) {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (!s) return ''
  s = s.normalize('NFKC').replace(/\s+/g, ' ').trim()
  for (const [re, rep] of PUNCT) s = s.replace(re, rep)
  s = s.replace(/\s+/g, ' ').trim()
  if (spec.mode === 'strict') return s
  s = convertUnits(s)
  s = convertCounters(s)
  s = s.trim()
  if (spec.caseInsensitive) s = s.toLowerCase()
  s = applySynonyms(s, spec.synonyms)
  return s.replace(/\s+/g, ' ').trim()
}

/** Resolve the normalization spec for one field from the contract. */
export function specFor(contract, field) {
  const global = contract?.normalization ?? {}
  const fieldSpec = field?.normalize && typeof field.normalize === 'object' ? field.normalize : {}
  return {
    mode: fieldSpec.mode ?? global.mode ?? 'safe',
    caseInsensitive: fieldSpec.caseInsensitive ?? global.caseInsensitive ?? false,
    synonyms: {
      ...expandSynonyms(global.synonyms),
      ...expandSynonyms(field?.synonyms),
      ...expandSynonyms(fieldSpec.synonyms),
    },
  }
}

/** True when the two raw values are equal after safe normalization. */
export function sameValue(a, b, spec) {
  return normalizeValue(a, spec) === normalizeValue(b, spec)
}
