import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
globalThis.__CHIBI_PROGRAM__ = '(import (scheme base) (scheme write)) (display "HELLO") (newline)'
const exported = require('./chibi.cjs')
console.error('exported type', typeof exported, 'keys', Object.keys(exported).slice(0, 20), 'hasReady', 'ready' in exported)
const instance = await exported
console.error('instance type', typeof instance, 'keys', Object.keys(instance).slice(0, 30))
if (instance && instance.FS) {
  console.error('FS root', instance.FS.readdir('/'))
}
