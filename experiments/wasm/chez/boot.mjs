import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUEST = join(HERE, 'guest.scm')
const RUNNER = join(HERE, '10.4.1', 'run.cjs')

function schemeString (value) {
  return JSON.stringify(String(value))
}

function schemeValue (value) {
  if (value === null) return "'()"
  if (typeof value === 'boolean') return value ? '#t' : '#f'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '#f'
  if (typeof value === 'string') return schemeString(value)
  if (Array.isArray(value)) return `(list ${value.map(schemeValue).join(' ')})`
  if (value && typeof value === 'object') {
    return `(list ${Object.entries(value).map(([key, item]) => `(cons ${schemeString(key)} ${schemeValue(item)})`).join(' ')})`
  }
  return '#f'
}

function buildProgram (guest, request) {
  const op = String(request.op)
  const source = schemeString(request.source ?? '')
  const arg = op === 'load-module'
    ? `(list ${(request.calls ?? []).map((call) => `(list ${schemeString(call.rule)} ${schemeValue(call.args ?? [])})`).join(' ')})`
    : schemeValue(request.args ?? [])
  return `${guest}\n(display (main (list ${schemeString(op)} ${source} ${arg})))\n(newline)\n`
}

async function main () {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const guest = await readFile(GUEST, 'utf8')
  const program = buildProgram(guest, request)

  const child = spawn(process.execPath, [RUNNER, '-q'], {
    cwd: join(HERE, '10.4.1'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.on('error', (error) => {
    process.stderr.write(error.message)
    process.exitCode = 1
  })
  child.on('close', (code) => {
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: 'ADAPTER_ERROR', message: `chez exited ${code}: ${stderr.slice(-500)}` },
      }) + '\n')
      return
    }
    const last = lines[lines.length - 1]
    try {
      const parsed = JSON.parse(last)
      process.stdout.write(JSON.stringify({ protocolVersion: 1, id: request.id, ...parsed }) + '\n')
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: 'PROTOCOL_ERROR', message: `invalid chez response: ${error.message}` },
      }) + '\n')
    }
  })
  child.stdin.end(program)
}

await main()
