// Worker-thread entry for opt-in isolated rule execution. Only the default
// primitive registry is available here; custom primitives/FFI stay in-process.
import { parentPort } from 'node:worker_threads'
import { compileRule } from './compiler.js'
import { compileSchemeRule } from './scheme/compile.js'

parentPort.on('message', async ({ source, args, limits, scheme = false, reader = {} }) => {
  try {
    const compiled = scheme
      ? compileSchemeRule(source, { limits, reader })
      : compileRule(source, { limits })
    const result = await compiled.invoke(args, { limits })
    parentPort.postMessage({ ok: true, result })
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        code: error?.code ?? 'RULE_ERROR',
        message: error?.message ?? String(error),
        path: error?.path ?? '$',
      },
    })
  }
})
