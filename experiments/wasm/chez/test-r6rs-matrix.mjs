import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'r6rs-library-matrix.json')
const CAP = 1 << 20
const MASK = CAP - 1
const OUT_POS = 2

const libraries = [
  { id: 'base', name: 'base', imports: ['(rnrs base (6))', '(rnrs io simple (6))'], expr: '(+ 1 2)' },
  { id: 'arithmetic-bitwise', name: 'arithmetic bitwise', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs arithmetic bitwise (6))'], expr: '(bitwise-and #b1100 #b1010)' },
  { id: 'arithmetic-fixnums', name: 'arithmetic fixnums', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs arithmetic fixnums (6))'], expr: '(fixnum? 1)' },
  { id: 'arithmetic-flonums', name: 'arithmetic flonums', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs arithmetic flonums (6))'], expr: '(flonum? 1.0)' },
  { id: 'bytevectors', name: 'bytevectors', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs bytevectors (6))'], expr: '(bytevector-u8-ref (bytevector 1 2) 0)' },
  { id: 'conditions', name: 'conditions', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs conditions (6))'], expr: '(condition? (make-message-condition "x"))' },
  { id: 'control', name: 'control', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs control (6))'], expr: '(call/cc (lambda (k) (k 5)))' },
  { id: 'enums', name: 'enums', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs enums (6))'], expr: "(enum-set-member? 'a (make-enumeration '(a b)))" },
  { id: 'eval', name: 'eval', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs eval (6))'], expr: "(eval '(+ 2 3) (environment '(rnrs base (6))))" },
  { id: 'exceptions', name: 'exceptions', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs exceptions (6))'], expr: "(guard (e (#t 7)) (raise 'x))" },
  { id: 'files', name: 'files', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs files (6))'], expr: '(file-exists? "/definitely-not-here")' },
  { id: 'hashtables', name: 'hashtables', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs hashtables (6))'], expr: '(hashtable? (make-eq-hashtable))' },
  { id: 'io-ports', name: 'io ports', imports: ['(rnrs base (6))', '(rnrs io ports (6))'], expr: '(get-string-all (open-string-input-port "abc"))' },
  { id: 'io-simple', name: 'io simple', imports: ['(rnrs base (6))', '(rnrs io simple (6))'], expr: '(input-port? (current-input-port))' },
  { id: 'lists', name: 'lists', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs lists (6))'], expr: "(find even? '(1 2 3))" },
  { id: 'mutable-pairs', name: 'mutable pairs', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs mutable-pairs (6))'], expr: '(let ((p (cons 1 2))) (set-car! p 9) (car p))' },
  { id: 'mutable-strings', name: 'mutable strings', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs mutable-strings (6))'], expr: '(let ((s (string-copy "abc"))) (string-set! s 0 #\\z) s)' },
  { id: 'programs', name: 'programs', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs programs (6))'], expr: '(procedure? command-line)' },
  { id: 'r5rs', name: 'r5rs', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs r5rs (6))'], expr: '(exact->inexact 1)' },
  { id: 'records-procedural', name: 'records procedural', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs records procedural (6))'], expr: "(let ((rtd (make-record-type-descriptor 'point #f #f #f #f '#()))) (record-type-descriptor? rtd))" },
  { id: 'records-syntactic', name: 'records syntactic', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs records syntactic (6))'], expr: '(let () (define-record-type point (fields (immutable x) (immutable y))) (point-x (make-point 1 2)))' },
  { id: 'records-inspection', name: 'records inspection', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs records syntactic (6))', '(rnrs records inspection (6))'], expr: '(let () (define-record-type point (fields (immutable x))) (record? (make-point 1)))' },
  { id: 'sorting', name: 'sorting', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs sorting (6))'], expr: "(list-sort < '(3 1 2))" },
  { id: 'syntax-case', name: 'syntax-case', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs syntax-case (6))'], expr: "(let-syntax ((m (lambda (x) (syntax-case x () ((_ a) #'a))))) (m 9))" },
  { id: 'unicode', name: 'unicode', imports: ['(rnrs base (6))', '(rnrs io simple (6))', '(rnrs unicode (6))'], expr: '(char-upcase #\\a)' },
  { id: 'composite', name: 'composite', imports: ['(rnrs (6))'], expr: '(+ 1 2)' },
]

function scriptFor (lib) {
  const imports = [...new Set(lib.imports)].join(' ')
  return `(import ${imports})
(display "MATRIX ${lib.id} ")
(guard (e (#t (display "FAIL\\n")))
  (display "PASS ")
  (write ${lib.expr})
  (newline))
(exit 0)
`
}

function runScript (lib) {
  const control = new SharedArrayBuffer(8 * 4)
  const input = new SharedArrayBuffer(CAP)
  const output = new SharedArrayBuffer(CAP)
  const ctrl = new Int32Array(control)
  const outBuf = new Uint8Array(output)
  let stderrText = ''
  let finished = null
  let failure = null
  let outRead = 0
  const chunks = []

  const drain = () => {
    const end = Atomics.load(ctrl, OUT_POS)
    if (end <= outRead) return
    const chunk = Buffer.alloc(end - outRead)
    for (let i = 0; i < chunk.length; i++) chunk[i] = outBuf[(outRead + i) & MASK]
    outRead = end
    Atomics.store(ctrl, OUT_POS - 2 + 3, outRead)
    chunks.push(chunk)
  }

  const worker = new Worker(new URL('./online-vm-worker.cjs', import.meta.url), {
    workerData: {
      control,
      input,
      output,
      scriptName: 'r6rs-matrix.scm',
      scriptSource: scriptFor(lib),
    },
  })
  worker.on('message', (message) => {
    if (message.type === 'exit') {
      finished = message
      stderrText = message.stderr || ''
    } else if (message.type === 'error') {
      failure = message
      stderrText = message.stderr || ''
    }
  })
  worker.on('error', (error) => {
    failure = { message: error.stack ?? String(error) }
  })

  return new Promise((resolve) => {
    const deadline = Date.now() + 10000
    const timer = setInterval(() => {
      if (finished !== null || failure !== null || Date.now() > deadline) {
        clearInterval(timer)
        drain()
        worker.terminate().then(() => {
          const stdout = Buffer.concat(chunks).toString('utf8')
          resolve({ stdout, stderr: stderrText, exit: finished, failure, timedOut: finished === null && failure === null })
        })
      }
    }, 10)
  })
}

const results = []
for (const lib of libraries) {
  const outcome = await runScript(lib)
  const match = outcome.stdout.match(new RegExp(`MATRIX ${lib.id} (PASS|FAIL)(?: ([^\\n]+))?`))
  const status = match ? match[1] : 'FAIL'
  results.push({
    id: lib.id,
    library: lib.name,
    imports: [...new Set(lib.imports)],
    expression: lib.expr,
    status,
    value: match?.[2] ?? null,
    stdout: outcome.stdout.trim(),
    stderr: outcome.stderr.trim().slice(0, 2000),
    exit: outcome.exit,
    failure: outcome.failure?.message ? String(outcome.failure.message).slice(0, 2000) : null,
    timedOut: outcome.timedOut,
  })
  console.log(`${lib.id}: ${status}${match?.[2] ? ` ${match[2]}` : ''}`)
}

const passed = results.filter((r) => r.status === 'PASS').length
const result = {
  ok: passed === results.length,
  checkedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  total: results.length,
  passed,
  failed: results.length - passed,
  results,
}
mkdirSync(dirname(RESULT), { recursive: true })
writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ ok: result.ok, total: result.total, passed, failed: result.failed, out: RESULT }, null, 2))
if (!result.ok) process.exit(1)
