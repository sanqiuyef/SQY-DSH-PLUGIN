/**
 * dsh-tool-search-mode — the settings page HTTP surface.
 *
 *   GET  /tool-search-mode/api/state   current mode + catalog stats
 *   POST /tool-search-mode/api/state   { mode: "auto" | "local" | "off" }
 *
 * Both go through the host's connection fence (authentication + Host/Origin
 * gate) and answer `no-store`: the mode is process state that the settings page
 * must never see cached.
 */

import { normalizeMode } from './settings.js'

const MAX_BODY_BYTES = 16 * 1024

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function rejectUnauthorized(ctx, request, response) {
  let rejection
  try {
    rejection = ctx.connection?.requestRejection?.(request)
  } catch {
    rejection = 500
  }
  if (rejection === undefined || rejection === null) return false
  response.writeHead(Number(rejection) || 403, { 'cache-control': 'no-store' })
  response.end()
  return true
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Register the settings routes.
 * @param {object} ctx
 * @param {{settings: object, engine: object, config: object}} deps
 * @returns {() => void}
 */
export function registerRoutes(ctx, { settings, engine, config }) {
  if (ctx?.webServer === undefined || typeof ctx.webServer.register !== 'function') return () => {}
  const disposers = []
  const register = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  const stateBody = () => ({
    mode: settings.current(),
    source: settings.source(),
    defaultMode: normalizeMode(config.mode, 'auto'),
    stats: engine.stats(),
    path: settings.path,
  })

  register('/tool-search-mode/api/state', async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return
    if (request.method === 'GET' || request.method === 'HEAD') {
      sendJson(response, 200, stateBody())
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' })
      response.end()
      return
    }
    const contentType = String(request.headers?.['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: { code: 'unsupported-media-type', message: 'send application/json' } })
      return
    }
    try {
      const raw = await readBody(request, MAX_BODY_BYTES)
      const parsed = raw === '' ? {} : JSON.parse(raw)
      const mode = parsed?.mode
      if (!['auto', 'local', 'off'].includes(String(mode ?? '').toLowerCase())) {
        sendJson(response, 400, { error: { code: 'bad-request', message: 'mode must be auto, local, or off' } })
        return
      }
      settings.set(mode)
      sendJson(response, 200, stateBody())
    } catch (error) {
      sendJson(response, 400, { error: { code: 'bad-request', message: String(error?.message ?? error) } })
    }
  })

  return () => { for (const dispose of disposers) dispose() }
}
