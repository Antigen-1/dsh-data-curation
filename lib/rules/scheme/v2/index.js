import { readFileSync } from 'node:fs'
import { SchemeV2Runtime, loadSchemeV2Pin } from './loader.js'
import { decodeSourceBase64, verifyEngine } from './pin-lib.js'

export const SCHEME_V2_ENGINE_CONTRACT = 'chez-wasm-c-10.4.1-v1'

export async function loadSchemeV2PinFile(pinPath, options = {}) {
  return loadSchemeV2Pin(JSON.parse(readFileSync(pinPath, 'utf8')), options)
}

export { SchemeV2Runtime, decodeSourceBase64, loadSchemeV2Pin, verifyEngine }
