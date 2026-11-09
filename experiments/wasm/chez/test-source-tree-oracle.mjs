// Independent JS reader/encoder oracle for the v2 SOURCE-TREE format.
// It deliberately does not reuse restricted-reader.scm. Raw vectors are parsed
// here, encoded with the same published format, hashed, then compared with the
// Chez guest output from a freshly generated test program.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const VECTORS = join(HERE, 'reader-vectors.json')
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'reader-oracle.json')
const NEGATIVE_RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'reader-negative.json')
const SOURCE_TREE_RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'source-tree.json')
const TREE_DOMAIN = Buffer.from('dsh/source-tree/v2\0', 'utf8')
const SOURCE_DOMAIN = Buffer.from('dsh/source-bytes/v2\0', 'utf8')
const MAX_DEPTH = 256
const MAX_FORMS = 100000
const MAX_LIST = 100000

class ReaderError extends Error {
  constructor (code, message, line, column) {
    super(`${code} at ${line}:${column}: ${message}`)
    this.code = code
    this.line = line
    this.column = column
  }
}

const DELIMITERS = new Set(['(', ')', '"', "'", '`', ',', ';', '|', '#'])

class Reader {
  constructor (source) {
    this.source = source
    this.index = 0
    this.line = 1
    this.column = 1
  }

  eof () { return this.index >= this.source.length }
  peek (offset = 0) { return this.source[this.index + offset] }
  advance () {
    const c = this.source[this.index++]
    if (c === '\n') { this.line++; this.column = 1 } else { this.column++ }
    return c
  }

  fail (code, message) { throw new ReaderError(code, message, this.line, this.column) }

  skipAtmosphere () {
    for (;;) {
      const c = this.peek()
      if (c === undefined) return
      if (/\s/.test(c)) { this.advance(); continue }
      if (c === ';') {
        while (!this.eof() && this.peek() !== '\n') this.advance()
        continue
      }
      if (c === '#' && this.peek(1) === '|') {
        this.advance(); this.advance()
        let depth = 1
        while (depth > 0) {
          if (this.eof()) this.fail('E-COMMENT-EOF', 'unterminated block comment')
          const d = this.advance()
          if (d === '#' && this.peek() === '|') { this.advance(); depth++; continue }
          if (d === '|' && this.peek() === '#') { this.advance(); depth--; }
        }
        continue
      }
      return
    }
  }

  readToken () {
    let out = ''
    while (!this.eof() && !DELIMITERS.has(this.peek()) && !/\s/.test(this.peek())) {
      out += this.advance()
    }
    return out
  }

  parseAll () {
    const forms = []
    for (;;) {
      this.skipAtmosphere()
      if (this.eof()) return forms
      if (forms.length >= MAX_FORMS) this.fail('E-FORMS', 'too many top-level forms')
      forms.push(this.parseDatum(0))
    }
  }

  parseDatum (depth) {
    if (depth > MAX_DEPTH) this.fail('E-DEPTH', 'maximum reader depth exceeded')
    this.skipAtmosphere()
    const c = this.peek()
    if (c === undefined) this.fail('E-EOF', 'unexpected end of input')
    if (c === '(') return this.parseList(depth)
    if (c === ')') this.fail('E-CLOSE', 'unexpected close parenthesis')
    if (c === "'") { this.advance(); return { kind: 'list', items: [symbol('quote'), this.parseDatum(depth + 1)] } }
    if (c === '"') return this.parseString()
    if (c === '#') return this.parseSharp(depth)
    if (c === '`' || c === ',') this.fail('E-UNSUPPORTED-READER', 'quasiquote/unquote is not supported')
    return this.parseAtom()
  }

  parseList (depth) {
    this.advance()
    const items = []
    for (;;) {
      this.skipAtmosphere()
      const c = this.peek()
      if (c === undefined) this.fail('E-LIST-EOF', 'unterminated list')
      if (c === ')') { this.advance(); return { kind: 'list', items } }
      if (c === '.' && (this.peek(1) === undefined || DELIMITERS.has(this.peek(1)) || /\s/.test(this.peek(1)))) {
        this.fail('E-DOTTED', 'dotted lists are not supported')
      }
      if (items.length >= MAX_LIST) this.fail('E-LIST-LENGTH', 'list too long')
      items.push(this.parseDatum(depth + 1))
    }
  }

  parseVector (depth) {
    this.advance()
    const items = []
    for (;;) {
      this.skipAtmosphere()
      const c = this.peek()
      if (c === undefined) this.fail('E-VECTOR-EOF', 'unterminated vector')
      if (c === ')') { this.advance(); return { kind: 'vector', items } }
      if (items.length >= MAX_LIST) this.fail('E-VECTOR-LENGTH', 'vector too long')
      items.push(this.parseDatum(depth + 1))
    }
  }

  parseBytevector (depth) {
    const items = []
    for (;;) {
      this.skipAtmosphere()
      const c = this.peek()
      if (c === undefined) this.fail('E-BV-EOF', 'unterminated bytevector')
      if (c === ')') { this.advance(); return { kind: 'bytevector', items } }
      if (items.length >= MAX_LIST) this.fail('E-BV-LENGTH', 'bytevector too long')
      const v = this.parseDatum(depth + 1)
      if (typeof v !== 'bigint' || v < 0n || v > 255n) {
        this.fail('E-BV-ELEMENT', 'bytevector element must be an integer 0..255')
      }
      items.push(Number(v))
    }
  }

  parseString () {
    this.advance()
    let out = ''
    for (;;) {
      if (this.eof()) this.fail('E-STRING-EOF', 'unterminated string')
      const c = this.advance()
      if (c === '"') return out
      if (c !== '\\') { out += c; continue }
      if (this.eof()) this.fail('E-ESCAPE-EOF', 'unterminated string escape')
      const e = this.advance()
      if (e === '"' || e === '\\') out += e
      else if (e === 'n') out += '\n'
      else if (e === 't') out += '\t'
      else if (e === 'r') out += '\r'
      else if (e === 'b') out += '\b'
      else if (e === 'f') out += '\f'
      else if (e === 'v') out += '\v'
      else if (e === 'x') {
        let hex = ''
        while (!this.eof() && this.peek() !== ';') hex += this.advance()
        if (this.eof()) this.fail('E-ESCAPE-EOF', 'unterminated hex escape')
        this.advance()
        if (!/^[0-9a-fA-F]+$/.test(hex)) this.fail('E-ESCAPE-HEX', 'invalid hex escape')
        const cp = parseInt(hex, 16)
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail('E-ESCAPE-HEX', 'invalid Unicode scalar')
        out += String.fromCodePoint(cp)
      } else this.fail('E-ESCAPE', 'unknown string escape')
    }
  }

  parseChar () {
    if (this.eof()) this.fail('E-CHAR-EOF', 'unterminated character literal')
    const c = this.peek()
    if (DELIMITERS.has(c) || /\s/.test(c)) {
      this.advance()
      return char(c.codePointAt(0))
    }
    const token = this.readToken()
    if ([...token].length === 1) return char(token.codePointAt(0))
    const names = {
      space: 0x20, newline: 0x0a, tab: 0x09, return: 0x0d, alarm: 0x07,
      backspace: 0x08, delete: 0x7f, escape: 0x1b, null: 0x00,
    }
    if (Object.prototype.hasOwnProperty.call(names, token)) return char(names[token])
    if (token.startsWith('x') && token.length > 1) {
      if (!/^[0-9a-fA-F]+$/.test(token.slice(1))) this.fail('E-CHAR-HEX', 'invalid character scalar')
      const cp = parseInt(token.slice(1), 16)
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail('E-CHAR-HEX', 'invalid character scalar')
      return char(cp)
    }
    this.fail('E-CHAR-NAME', 'unknown character name')
  }

  parseSharp (depth) {
    this.advance()
    const c = this.peek()
    if (c === undefined) this.fail('E-SHARP-EOF', 'incomplete # syntax')
    if (c === '(') return this.parseVector(depth)
    if (c === '\\') { this.advance(); return this.parseChar() }
    if (c === '|') this.fail('E-COMMENT', 'comment must be skipped by atmosphere')
    if (c === ';') this.fail('E-READER-EVAL', '#; reader eval is not supported')
    if (c === '!') this.fail('E-DIRECTIVE', '#! directives are not supported')
    const low = c.toLowerCase()
    if (low === 't' || low === 'f') {
      const token = this.readToken().toLowerCase()
      if (token === 't' || token === 'true') return true
      if (token === 'f' || token === 'false') return false
      this.fail('E-BOOLEAN', 'invalid boolean literal')
    }
    if (low === 'v') {
      this.advance()
      if (this.peek()?.toLowerCase() !== 'u') this.fail('E-BV-SYNTAX', 'expected #vu8(')
      this.advance()
      if (this.peek() !== '8') this.fail('E-BV-SYNTAX', 'expected #vu8(')
      this.advance()
      if (this.peek() !== '(') this.fail('E-BV-SYNTAX', 'expected #vu8(')
      this.advance()
      return this.parseBytevector(depth)
    }
    if (['x', 'o', 'b', 'd'].includes(low)) {
      const base = { x: 16, o: 8, b: 2, d: 10 }[low]
      this.advance()
      const token = this.readToken()
      const v = signedInteger(token, base)
      if (v === null) this.fail('E-NUMBER', 'invalid radix integer')
      return v
    }
    this.fail('E-SHARP', 'unsupported # syntax')
  }

  parseAtom () {
    const token = this.readToken()
    if (token === '') this.fail('E-TOKEN', 'empty token')
    const special = specialReal(token)
    if (special !== null) return special
    if (token.includes('/')) {
      const v = rationalToken(token)
      if (v === null) this.fail('E-NUMBER', 'invalid rational')
      return v
    }
    const integer = decimalIntegerToken(token)
    if (integer !== null) return integer
    if (decimalToken(token)) {
      const n = Number(token)
      if (Number.isFinite(n) || !/inf|nan/i.test(token)) return n
      this.fail('E-NUMBER', 'invalid real')
    }
    if (looksNumeric(token)) this.fail('E-NUMBER', 'invalid number')
    if (validSymbol(token)) return symbol(token)
    this.fail('E-SYMBOL', 'invalid symbol')
  }
}

function symbol (name) { return { kind: 'symbol', name } }
function char (cp) { return { kind: 'char', cp } }

function specialReal (token) {
  if (token === '+inf.0') return Infinity
  if (token === '-inf.0') return -Infinity
  if (token === '+nan.0' || token === '-nan.0') return NaN
  return null
}

function decimalIntegerToken (token) {
  if (!/^[+-]?\d+$/.test(token)) return null
  return BigInt(token)
}

function rationalToken (token) {
  const at = token.indexOf('/')
  if (at <= 0 || at === token.length - 1) return null
  const n = token.slice(0, at)
  const d = token.slice(at + 1)
  if (!/^[+-]?\d+$/.test(n) || !/^\d+$/.test(d)) return null
  const den = BigInt(d)
  if (den === 0n) return null
  return { kind: 'rational', num: BigInt(n), den }
}

function decimalToken (token) {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)
}

function looksNumeric (token) {
  return /^[+-]?(?:\d|\.\d|inf\.0|nan\.0)/i.test(token)
}

function validSymbol (token) {
  if (token === '...') return true
  return /^[A-Za-z!$%&*/:<=>?^_~+-][A-Za-z0-9!$%&*/:<=>?^_~.+-]*$/.test(token)
}

function signedInteger (token, base) {
  if (!new RegExp(`^[+-]?[0-9a-fA-F]+$`).test(token)) return null
  const negative = token[0] === '-'
  const digits = token.replace(/^[+-]/, '')
  if (![...digits].every((d) => parseInt(d, base) < base && /[0-9a-fA-F]/.test(d))) return null
  try {
    const v = BigInt(parseInt(digits, base).toString())
    return negative ? -v : v
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Canonical encoder
// ---------------------------------------------------------------------------

function u32 (n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

function encodeUtf8 (s) {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([u32(b.length), b])
}

function encodeInteger (n) {
  const negative = n < 0n
  const digits = Buffer.from((negative ? -n : n).toString(10), 'ascii')
  return Buffer.concat([Buffer.from([0x04, negative ? 1 : 0]), u32(digits.length), digits])
}

function encodeReal (n) {
  if (Number.isNaN(n)) return Buffer.from([0x06, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f])
  const b = Buffer.alloc(8)
  b.writeDoubleLE(n)
  return Buffer.concat([Buffer.from([0x06]), b])
}

function encodeDatum (v) {
  if (v === true) return Buffer.from([0x07, 1])
  if (v === false) return Buffer.from([0x07, 0])
  if (typeof v === 'bigint') return encodeInteger(v)
  if (typeof v === 'number') return encodeReal(v)
  if (typeof v === 'string') return Buffer.concat([Buffer.from([0x03]), encodeUtf8(v)])
  if (v && v.kind === 'rational') return Buffer.concat([Buffer.from([0x05]), encodeInteger(v.num), encodeInteger(v.den)])
  if (v && v.kind === 'symbol') return Buffer.concat([Buffer.from([0x02]), encodeUtf8(v.name)])
  if (v && v.kind === 'char') return Buffer.concat([Buffer.from([0x08]), u32(v.cp)])
  if (v && v.kind === 'bytevector') return Buffer.concat([Buffer.from([0x0a]), u32(v.items.length), Buffer.from(v.items)])
  if (v && v.kind === 'vector') return Buffer.concat([Buffer.from([0x09]), u32(v.items.length), ...v.items.map(encodeDatum)])
  if (v && v.kind === 'list') return Buffer.concat([Buffer.from([0x01]), u32(v.items.length), ...v.items.map(encodeDatum)])
  throw new Error(`unsupported datum: ${Object.prototype.toString.call(v)}`)
}

function canonicalSource (source) {
  const forms = new Reader(source).parseAll()
  return Buffer.concat([Buffer.from([0x10]), u32(forms.length), ...forms.map(encodeDatum)])
}

function sha256 (...parts) {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest('hex')
}

// ---------------------------------------------------------------------------
// Guest harness
// ---------------------------------------------------------------------------

function schemeString (s) {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else if (cp >= 0x20 && cp <= 0x7e) out += ch
    else out += `\\x${cp.toString(16)};`
  }
  return out + '"'
}

function runGuest (scriptSource) {
  return new Promise((resolve, reject) => {
    const CAP = 1 << 20
    const MASK = CAP - 1
    const control = new SharedArrayBuffer(32)
    const input = new SharedArrayBuffer(CAP)
    const output = new SharedArrayBuffer(CAP)
    const ctrl = new Int32Array(control)
    const outBuf = new Uint8Array(output)
    const OUT_POS = 2
    const OUT_READ = 3
    let outRead = 0
    const chunks = []
    let exit = null
    let failure = null
    let stderrText = ''

    const drain = () => {
      const end = Atomics.load(ctrl, OUT_POS)
      if (end <= outRead) return
      const chunk = Buffer.alloc(end - outRead)
      for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
      outRead = end
      Atomics.store(ctrl, OUT_READ, outRead)
      Atomics.notify(ctrl, OUT_READ)
      chunks.push(chunk)
    }

    const worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
      workerData: {
        control,
        input,
        output,
        scriptName: 'oracle-generated.scm',
        scriptSource,
        extraFiles: ['source-tree-reader.scm'],
      },
    })
    worker.on('message', (message) => {
      if (message.type === 'exit') { exit = message; stderrText = message.stderr || '' }
      else if (message.type === 'error') { failure = message; stderrText = message.stderr || '' }
    })
    worker.on('error', (error) => { failure = { message: error.stack ?? String(error) } })

    const deadline = Date.now() + 30000
    const poll = () => {
      drain()
      if (exit !== null || failure !== null) {
        drain()
        worker.terminate().finally(() => {
          if (failure) return reject(new Error(failure.message))
          if (exit.code !== 0) return reject(new Error(`guest exited ${exit.code}: ${stderrText}`))
          resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr: stderrText })
        })
        return
      }
      if (Date.now() > deadline) {
        worker.terminate().finally(() => reject(new Error('guest timed out')))
        return
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}

async function main () {
  const vectors = JSON.parse(readFileSync(VECTORS, 'utf8'))
  const lines = ['(load "/source-tree-reader.scm")']
  lines.push('(define (emit id source)')
  lines.push('  (display "V ") (display id) (display " ")')
  lines.push('  (display (bytevector->hex (canonical-source-bytes source))) (display " ")')
  lines.push('  (display (tree-hash source)) (newline))')
  lines.push('(define (check id source)')
  lines.push('  (display "I ") (display id) (display " ")')
  lines.push('  (display')
  lines.push('    (call/cc')
  lines.push('      (lambda (escape)')
  lines.push('        (with-exception-handler')
  lines.push('          (lambda (e)')
  lines.push('            (escape (cond ((and (list? e) (eq? (car e) (quote source-error))) (cadr e))')
  lines.push('                          (else "E-READ"))))')
  lines.push('          (lambda ()')
  lines.push('            (canonical-source-bytes source)')
  lines.push('            (escape "NO-ERROR"))))))')
  lines.push('  (newline))')
  lines.push('(define (diagnose id source)')
  lines.push('  (display "D ") (display id) (display " ")')
  lines.push('  (call/cc')
  lines.push('    (lambda (escape)')
  lines.push('      (with-exception-handler')
  lines.push('        (lambda (e)')
  lines.push('          (if (and (list? e) (eq? (car e) (quote source-error)) (>= (length e) 7))')
  lines.push('              (begin (display (cadr e)) (display " ") (display (cadddr e)) (display " ")')
  lines.push('                     (display (list-ref e 4)) (display " ") (display (list-ref e 5)) (display " ")')
  lines.push('                     (display (list-ref e 6)) (newline) (escape #t))')
  lines.push('              (begin (display "E-READ unknown 0 0 v2") (newline) (escape #t))))')
  lines.push('        (lambda ()')
  lines.push('          (tree-hash source "rule-abc")')
  lines.push('          (display "NO-ERROR - 0 0 v2") (newline) (escape #t))))))')
  for (const v of vectors.valid) lines.push(`(emit ${schemeString(v.id)} ${schemeString(v.source)})`)
  for (const v of vectors.cases) lines.push(`(check ${schemeString(v.id)} ${schemeString(v.source)})`)
  for (const v of vectors.cases) lines.push(`(diagnose ${schemeString(v.id)} ${schemeString(v.source)})`)
  lines.push('(exit 0)')
  const guest = await runGuest(lines.join('\n') + '\n')

  const actual = new Map()
  const edgeActual = new Map()
  const diagnostics = new Map()
  for (const line of guest.stdout.split('\n')) {
    if (line.startsWith('V ')) {
      const [tag, id, canonicalHex, treeHash] = line.split(' ')
      actual.set(id, { canonicalHex, treeHash })
    } else if (line.startsWith('I ')) {
      const [tag, id, code] = line.split(' ')
      edgeActual.set(id, code)
    } else if (line.startsWith('D ')) {
      const [tag, id, code, ruleId, lineNo, column, version] = line.split(' ')
      diagnostics.set(id, {
        code,
        ruleId,
        line: Number(lineNo),
        column: Number(column),
        version,
      })
    }
  }

  const results = []
  for (const v of vectors.valid) {
    const canonical = canonicalSource(v.source)
    const expected = {
      canonicalHex: canonical.toString('hex'),
      treeHash: sha256(TREE_DOMAIN, canonical),
    }
    const got = actual.get(v.id)
    const pass = Boolean(got) && got.canonicalHex === expected.canonicalHex &&
      got.treeHash === expected.treeHash
    results.push({ id: v.id, source: v.source, pass, expected, actual: got ?? null })
  }

  const edgeResults = vectors.cases.map((v) => {
    const actualCode = edgeActual.get(v.id) ?? null
    const diagnostic = diagnostics.get(v.id) ?? null
    const diagnosticPass = Boolean(diagnostic) && diagnostic.version === 'v2' &&
      (v.kind === 'readable'
        ? diagnostic.code === 'NO-ERROR'
        : diagnostic.code !== 'NO-ERROR' && diagnostic.ruleId === 'rule-abc' &&
          diagnostic.line >= 1 && diagnostic.column >= 1) &&
      (v.line === undefined || (diagnostic.line === v.line && diagnostic.column === v.column))
    return {
      id: v.id,
      source: v.source,
      kind: v.kind,
      expectedCode: v.expect,
      actualCode,
      pass: actualCode === v.expect && diagnosticPass,
      diagnostic,
    }
  })
  const result = {
    ok: results.every((r) => r.pass) && edgeResults.every((r) => r.pass),
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    vectorFile: 'experiments/wasm/chez/reader-vectors.json',
    guestStderr: guest.stderr,
    validCount: results.length,
    validPass: results.filter((r) => r.pass).length,
    edgeCount: edgeResults.length,
    edgePass: edgeResults.filter((r) => r.pass).length,
    results,
    edgeResults,
  }
  mkdirSync(dirname(RESULT), { recursive: true })
  writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n')
  writeFileSync(NEGATIVE_RESULT, JSON.stringify({
    ok: edgeResults.every((r) => r.pass),
    checkedAt: result.checkedAt,
    vectorFile: result.vectorFile,
    edgeCount: edgeResults.length,
    edgePass: edgeResults.filter((r) => r.pass).length,
    edgeResults,
  }, null, 2) + '\n')
  writeFileSync(SOURCE_TREE_RESULT, JSON.stringify({
    ok: results.every((r) => r.pass),
    checkedAt: result.checkedAt,
    specVersion: 'v2',
    canonicalHashDomain: 'dsh/source-tree/v2\\0',
    reader: 'Chez read + datum validator (readtable unrestricted)',
    vectorFile: result.vectorFile,
    validCount: results.length,
    validPass: results.filter((r) => r.pass).length,
    vectorIds: results.map((r) => r.id),
  }, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error.stack ?? String(error))
  process.exitCode = 1
}

