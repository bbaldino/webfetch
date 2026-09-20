// The HTTP router for webfetch's REST frontend. Pure — takes its dependencies as arguments so it
// can be unit tested without constructing a browser. `server.ts` is the only place that builds
// the real deps (BrowserManager, DomainDb, SessionManager) and wires them in.
import type http from 'node:http'
import type { SessionManager } from './session-manager.js'

export type FetchPageHandler = (
  args: { url: string },
  ctx: unknown,
) => Promise<{ url: string; method: string; title?: string; content?: string; error?: string }>

export interface RouterDeps {
  fetchPage: FetchPageHandler
  sessions: SessionManager
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createRouter(deps: RouterDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'GET' && pathname === '/health') {
        json(res, 200, { status: 'ok' })
        return
      }

      if (req.method === 'POST' && pathname === '/fetch') {
        const raw = await readBody(req)
        let url: unknown
        try {
          url = (JSON.parse(raw || '{}') as { url?: unknown }).url
        } catch {
          json(res, 400, { error: 'invalid JSON body' })
          return
        }
        if (typeof url !== 'string' || url.length === 0) {
          json(res, 400, { error: 'a "url" string is required' })
          return
        }
        // The fetch_page handler only touches ctx.fetch/getRunId — a minimal ToolContext suffices.
        const ctx = { credentials: {}, fetch: globalThis.fetch }
        const result = await deps.fetchPage({ url }, ctx)
        if (result.error) {
          json(res, 502, { error: result.error, final_url: result.url })
          return
        }
        json(res, 200, {
          title: result.title ?? '',
          text: result.content ?? '',
          final_url: result.url,
          method: result.method,
        })
        return
      }

      // A bare/wrong route is almost always a client misconfig (e.g. a base URL
      // set to the host with no `/fetch` path, so requests land on `/`). Say what
      // the valid routes are instead of a blank "not found".
      json(res, 404, {
        error: 'not found',
        hint: 'POST /fetch with JSON {"url":"..."}, or GET /health',
      })
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
    }
  }
}
