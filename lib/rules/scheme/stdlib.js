import { readFileSync } from 'node:fs'

/** Authoritative restricted-Scheme source for the flat-contract library. */
export const STANDARD_LIBRARY_SOURCE = readFileSync(new URL('./stdlib.scm', import.meta.url), 'utf8')
