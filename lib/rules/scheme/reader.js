// lib/rules/scheme/reader.js — R6RS-subset reader for the Scheme frontend.
import { RuleError } from '../errors.js'

const DELIMITERS = new Set(['(', ')', '[', ']', '"', ';', "'", '`', ','])

function spanOf(start, end, line, column) {
  return Object.freeze({ start, end, line, column })
}

function readError(message, span, code = 'SCHEME_READ') {
  const where = span ? `（第 ${span.line} 行第 ${span.column} 列）` : ''
  return new RuleError(code, `${message}${where}`, {
    path: '$',
    detail: span ? { line: span.line, column: span.column, start: span.start, end: span.end } : undefined,
  })
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

function tokenize(source, { maxTokens }) {
  const tokens = []
  let i = 0
  let line = 1
  let column = 1

  const advance = (count = 1) => {
    for (let n = 0; n < count; n++) {
      if (source[i] === '\n') {
        line += 1
        column = 1
      } else {
        column += 1
      }
      i += 1
    }
  }

  const push = (type, value, start, end, tokenLine, tokenColumn) => {
    if (tokens.length >= maxTokens) {
      throw readError(`token 数量超过上限 ${maxTokens}`, spanOf(start, end, tokenLine, tokenColumn))
    }
    tokens.push({ type, value, span: spanOf(start, end, tokenLine, tokenColumn) })
  }

  while (i < source.length) {
    const ch = source[i]

    if (isSpace(ch)) {
      advance()
      continue
    }

    if (ch === ';') {
      while (i < source.length && source[i] !== '\n') advance()
      continue
    }

    if (ch === '#' && source[i + 1] === '|') {
      const start = i
      const startLine = line
      const startColumn = column
      let depth = 1
      advance(2)
      while (i < source.length && depth > 0) {
        if (source[i] === '#' && source[i + 1] === '|') {
          depth += 1
          advance(2)
        } else if (source[i] === '|' && source[i + 1] === '#') {
          depth -= 1
          advance(2)
        } else {
          advance()
        }
      }
      if (depth !== 0) {
        throw readError('块注释没有闭合', spanOf(start, source.length, startLine, startColumn))
      }
      continue
    }

    if (ch === '#' && source[i + 1] === ';') {
      const start = i
      const startLine = line
      const startColumn = column
      advance(2)
      push('datum-comment', null, start, i, startLine, startColumn)
      continue
    }

    if (ch === '(' || ch === '[') {
      const start = i
      const startLine = line
      const startColumn = column
      advance()
      push(ch === '(' ? 'lparen' : 'lbracket', ch, start, i, startLine, startColumn)
      continue
    }

    if (ch === ')' || ch === ']') {
      const start = i
      const startLine = line
      const startColumn = column
      advance()
      push(ch === ')' ? 'rparen' : 'rbracket', ch, start, i, startLine, startColumn)
      continue
    }

    if (ch === "'") {
      const start = i
      const startLine = line
      const startColumn = column
      advance()
      push('quote', "'", start, i, startLine, startColumn)
      continue
    }

    if (ch === '`' || ch === ',') {
      throw readError(`不支持 quasiquote/comma 语法：${ch}`, spanOf(i, i + 1, line, column))
    }

    if (ch === '"') {
      const start = i
      const startLine = line
      const startColumn = column
      advance()
      let text = ''
      let closed = false
      while (i < source.length) {
        const current = source[i]
        if (current === '"') {
          advance()
          closed = true
          break
        }
        if (current === '\\') {
          advance()
          if (i >= source.length) break
          const escaped = source[i]
          if (escaped === 'n') { text += '\n'; advance(); continue }
          if (escaped === 't') { text += '\t'; advance(); continue }
          if (escaped === 'r') { text += '\r'; advance(); continue }
          if (escaped === '"' || escaped === '\\') { text += escaped; advance(); continue }
          if (escaped === 'x') {
            advance()
            let hex = ''
            while (i < source.length && source[i] !== ';') {
              hex += source[i]
              advance()
            }
            if (source[i] !== ';' || !/^[0-9a-fA-F]+$/.test(hex)) {
              throw readError('字符串的 \\x 转义必须形如 \\xHH;', spanOf(start, i, startLine, startColumn))
            }
            advance()
            const codePoint = Number.parseInt(hex, 16)
            if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
              throw readError('字符串的 \\x 转义不是合法的 Unicode 标量值', spanOf(start, i, startLine, startColumn))
            }
            text += String.fromCodePoint(codePoint)
            continue
          }
          throw readError(`未知字符串转义：\\${escaped}`, spanOf(i - 1, i + 1, line, column - 1))
        }
        text += current
        advance()
      }
      if (!closed) throw readError('字符串没有闭合', spanOf(start, i, startLine, startColumn))
      push('string', text, start, i, startLine, startColumn)
      continue
    }

    if (ch === '#' && source[i + 1] === '(') {
      throw readError('不支持 vector 字面量', spanOf(i, i + 2, line, column))
    }
    if (ch === '#' && /[\\xdbox]/i.test(source[i + 1] ?? '')) {
      throw readError('不支持字符、精确数或其它 # 前缀字面量', spanOf(i, i + 2, line, column))
    }

    const start = i
    const startLine = line
    const startColumn = column
    while (i < source.length && !isSpace(source[i]) && !DELIMITERS.has(source[i])) {
      if (source[i] === '#' && source[i + 1] === '|') break
      advance()
    }
    if (i === start) {
      throw readError(`无法识别的字符：${source[i]}`, spanOf(i, i + 1, line, column))
    }
    push('atom', source.slice(start, i), start, i, startLine, startColumn)
  }

  return tokens
}

function parseAtom(token) {
  const text = token.value
  if (text === '#t' || text === '#true') return { kind: 'boolean', value: true, span: token.span }
  if (text === '#f' || text === '#false') return { kind: 'boolean', value: false, span: token.span }
  if (text === '#!r6rs') return { kind: 'directive', value: text, span: token.span }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    const value = Number(text)
    if (!Number.isFinite(value)) throw readError('数值必须是有限数字', token.span)
    return { kind: 'number', value, span: token.span }
  }
  if (text === '.') throw readError('不支持 dotted list 语法', token.span)
  if (text.startsWith('#')) throw readError(`不支持的 # 字面量：${text}`, token.span)
  return { kind: 'symbol', value: text, span: token.span }
}

/**
 * Read all datums from a Scheme source string. Datums carry start/end offsets
 * plus one-based line/column; the lowerer uses them for diagnostics.
 */
export function normalizeReaderOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Scheme reader options 必须是对象')
  }
  const allowed = new Set(['maxSourceBytes', 'maxTokens', 'maxDepth'])
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw readError(`未知 reader option：${key}`, null)
  }
  const normalized = {
    maxSourceBytes: options.maxSourceBytes ?? 1_000_000,
    maxTokens: options.maxTokens ?? 100_000,
    maxDepth: options.maxDepth ?? 256,
  }
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 1) throw readError(`${name} 必须是正安全整数`, null)
  }
  return normalized
}

export function readScheme(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Scheme 源码必须是字符串')
  const { maxSourceBytes, maxTokens, maxDepth } = normalizeReaderOptions(options)
  if (Buffer.byteLength(source, 'utf8') > maxSourceBytes) {
    throw readError(`源码字节数超过上限 ${maxSourceBytes}`, null)
  }
  const tokens = tokenize(source, { maxTokens })
  let cursor = 0
  let commentDepth = 0

  const skipDatumComments = (depth) => {
    while (true) {
      if (tokens[cursor]?.type === 'datum-comment') {
        cursor += 1
        commentDepth += 1
        readDatum(depth + 1)
        commentDepth -= 1
        continue
      }
      if (tokens[cursor]?.type === 'directive' || (tokens[cursor]?.type === 'atom' && tokens[cursor].value === '#!r6rs')) {
        cursor += 1
        continue
      }
      break
    }
  }

  function readList(open, depth) {
    const closeType = open.type === 'lparen' ? 'rparen' : 'rbracket'
    const items = []
    while (true) {
      skipDatumComments(depth)
      const token = tokens[cursor]
      if (!token) {
        throw readError('列表没有闭合', open.span)
      }
      if (token.type === 'rparen' || token.type === 'rbracket') {
        if (token.type !== closeType) {
          throw readError('括号类型不匹配', token.span)
        }
        cursor += 1
        return { kind: 'list', items, span: spanOf(open.span.start, token.span.end, open.span.line, open.span.column) }
      }
      items.push(readDatum(depth + 1))
    }
  }

  function readDatum(depth = 0) {
    if (depth > maxDepth) throw readError(`嵌套深度超过上限 ${maxDepth}`, tokens[cursor]?.span ?? null)
    skipDatumComments(depth)
    const token = tokens[cursor]
    if (!token) throw readError('意外的源码结尾', null)
    cursor += 1
    switch (token.type) {
      case 'datum-comment':
        return readDatum(depth + 1)
      case 'lparen':
      case 'lbracket':
        return readList(token, depth)
      case 'rparen':
      case 'rbracket':
        throw readError('多余的右括号', token.span)
      case 'string':
        return { kind: 'string', value: token.value, span: token.span }
      case 'atom':
        return parseAtom(token)
      case 'quote': {
        const quoted = readDatum(depth + 1)
        const span = spanOf(token.span.start, quoted.span.end, token.span.line, token.span.column)
        return {
          kind: 'list',
          items: [{ kind: 'symbol', value: 'quote', span: token.span }, quoted],
          span,
        }
      }
      default:
        throw readError(`未知 token：${token.type}`, token.span)
    }
  }

  const datums = []
  while (true) {
    skipDatumComments(0)
    if (cursor >= tokens.length) break
    if (commentDepth > 0) throw readError('#; 后缺少 datum', tokens[cursor]?.span ?? null)
    datums.push(readDatum())
  }
  return { datums, source }
}

export function symbolName(datum) {
  return datum?.kind === 'symbol' ? datum.value : null
}
