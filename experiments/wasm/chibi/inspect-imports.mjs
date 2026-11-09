import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const file = new URL('./0.12.0/chibi.wasm', import.meta.url)
const bytes = await readFile(file)
const module = await WebAssembly.compile(bytes)
const imports = WebAssembly.Module.imports(module)
  .map((item) => `${item.module}.${item.name}`)
  .sort()
console.log(JSON.stringify({
  wasm: [...new Set(imports.map((item) => item.split('.')[0]))],
  importCount: imports.length,
  evalLike: imports.filter((item) => /eval|script|js/i.test(item)),
  sha256: createHash('sha256').update(bytes).digest('hex'),
}, null, 2))
