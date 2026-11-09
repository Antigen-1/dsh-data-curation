import { createServer } from 'node:http'
import { createAdapter as createChibi } from '../chibi/adapter.mjs'
import { createAdapter as createChez } from '../chez/adapter.mjs'

const ADAPTERS = {
  chibi: createChibi(),
  chez: createChez(),
}

function send (res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function startRpcServer ({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, { ok: true, engines: Object.keys(ADAPTERS) })
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'POST /rpc' } })
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      send(res, 400, { ok: false, error: { code: 'BAD_JSON', message: error.message } })
      return
    }
    const adapter = ADAPTERS[body.engine ?? 'chibi']
    if (!adapter) {
      send(res, 400, { ok: false, error: { code: 'UNKNOWN_ENGINE', message: String(body.engine) } })
      return
    }
    try {
      const response = await adapter.invoke(body.request ?? body)
      send(res, 200, { engine: body.engine ?? 'chibi', ...response })
    } catch (error) {
      send(res, 500, { ok: false, error: { code: 'SERVICE_ERROR', message: error.message } })
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve({
        url: `http://${host}:${address.port}`,
        close: () => new Promise((accept) => server.close(accept)),
      })
    })
  })
}
