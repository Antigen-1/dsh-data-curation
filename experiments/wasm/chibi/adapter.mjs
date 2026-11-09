import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOT = join(HERE, 'boot.mjs')

function protocolError (message, code = 'ADAPTER_ERROR') {
  return { protocolVersion: 1, ok: false, error: { code, message } }
}

export function createAdapter () {
  return {
    name: 'chibi-0.12.0-wasm',
    async invoke (request) {
      const timeoutMs = request?.limits?.wallTimeoutMs ?? 2000
      const maxOutputBytes = request?.limits?.maxOutputBytes ?? 1_000_000
      return await new Promise((resolve) => {
        const child = spawn(process.execPath, [BOOT], {
          cwd: HERE,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (response) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(response)
        }
        const timer = setTimeout(() => {
          child.kill()
          finish(protocolError(`chibi request exceeded ${timeoutMs}ms`, 'TIMEOUT'))
        }, timeoutMs)
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString()
          if (Buffer.byteLength(stdout) > maxOutputBytes) {
            child.kill()
            finish(protocolError(`chibi output exceeded ${maxOutputBytes} bytes`, 'OUTPUT_LIMIT'))
          }
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString()
          if (stderr.length > 20_000) stderr = stderr.slice(-20_000)
        })
        child.on('error', (error) => finish(protocolError(error.message)))
        child.on('close', (code) => {
          const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          if (lines.length === 0) {
            finish(protocolError(`chibi exited ${code} without a response: ${stderr.slice(-500)}`))
            return
          }
          try {
            finish(JSON.parse(lines[lines.length - 1]))
          } catch (error) {
            finish(protocolError(`invalid chibi response: ${error.message}`))
          }
        })
        child.stdin.end(`${JSON.stringify(request)}\n`)
      })
    },
  }
}
