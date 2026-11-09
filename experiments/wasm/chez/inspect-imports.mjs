import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const bytes = await readFile(new URL('./10.4.1/scheme.wasm', import.meta.url))
const module = await WebAssembly.compile(bytes)
const imports = WebAssembly.Module.imports(module)
  .map((item) => `${item.module}.${item.name}`)
  .sort()
console.log(JSON.stringify({
  modules: [...new Set(imports.map((item) => item.split('.')[0]))],
  importCount: imports.length,
  evalLike: imports.filter((item) => /eval|script/i.test(item)),
  sha256: createHash('sha256').update(bytes).digest('hex'),
}, null, 2))
