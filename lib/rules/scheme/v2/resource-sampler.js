import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const WINDOWS_RSS = 'powershell.exe'
const WINDOWS_ARGS = ['-NoProfile', '-NonInteractive', '-Command']

function parseWindowsRss (text) {
  const value = String(text).trim()
  if (!/^\d+$/.test(value)) throw new Error('invalid Windows RSS output')
  return Number(value)
}

export function parseLinuxRss (text) {
  const match = /^VmRSS:[ \t]+(\d+)[ \t]+kB$/m.exec(String(text))
  if (!match) throw new Error('VmRSS not found')
  return Number(match[1]) * 1024
}

export function createRssSampler ({ platform = process.platform, exec = execFile, read = readFile } = {}) {
  if (platform === 'linux') {
    return async (pid) => parseLinuxRss(await read(`/proc/${pid}/status`, 'utf8'))
  }
  if (platform === 'win32') {
    return (pid) => new Promise((resolve, reject) => {
      exec(WINDOWS_RSS, [...WINDOWS_ARGS, `(Get-Process -Id ${Number(pid)}).WorkingSet64`], {
        windowsHide: true,
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        if (error) reject(error)
        else {
          try { resolve(parseWindowsRss(stdout)) } catch (parseError) { reject(parseError) }
        }
      })
    })
  }
  return null
}
