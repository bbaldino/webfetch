// The HTTP router for webfetch's REST frontend. Pure — takes its dependencies as arguments so it
// can be unit tested without constructing a browser. `server.ts` is the only place that builds
// the real deps (BrowserManager, DomainDb, SessionManager) and wires them in.
import type http from 'node:http'
import * as browse from './browse.js'
import { SessionCapReached, SessionNotFound, type SessionManager } from './session-manager.js'
import { openapiSpec } from './openapi.js'
import { validateWaitFor, BrowseArgError } from './browse-tools.js'

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

      // The service describes itself — clients/agents can fetch the contract.
      if (req.method === 'GET' && pathname === '/openapi.json') {
        json(res, 200, openapiSpec)
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

      // --- sessions ---
      if (pathname === '/sessions' && req.method === 'POST') {
        try {
          const { id, expiresInMs } = await deps.sessions.create()
          json(res, 201, { session_id: id, expires_in_ms: expiresInMs })
        } catch (err) {
          mapError(res, err)
        }
        return
      }

      const m = pathname.match(/^\/sessions\/([^/]+)(?:\/([^/]+))?$/)
      if (m) {
        const id = decodeURIComponent(m[1])
        const op = m[2]
        if (req.method === 'DELETE' && !op) {
          await deps.sessions.close(id)
          res.writeHead(204).end()
          return
        }
        if (req.method === 'POST' && op) {
          const raw = await readBody(req)
          let body: Record<string, unknown>
          try {
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
          } catch {
            json(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const result = await runOp(deps.sessions, id, op, body)
            json(res, 200, result)
          } catch (err) {
            mapError(res, err)
          }
          return
        }
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

function need(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || v.length === 0) throw new BadRequest(`"${key}" string is required`)
  return v
}

function needValues(body: Record<string, unknown>): string[] {
  const v = body.values
  if (!Array.isArray(v) || v.length === 0) throw new BadRequest('"values" array is required')
  return v as string[]
}

function needWaitFor(body: Record<string, unknown>): browse.WaitFor {
  return validateWaitFor(body.wait_for)
}

function optionalWaitFor(body: Record<string, unknown>): browse.WaitFor | undefined {
  if (body.wait_for === undefined) return undefined
  return validateWaitFor(body.wait_for)
}

const MAX_TIMEOUT_MS = 60000

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new BadRequest(`"${key}" must be a number`)
  }
  return v
}

// Same as optionalNumber, but clamps to a sane upper bound instead of
// rejecting — an overlong timeout is a nuisance, not a malformed request.
function optionalTimeoutMs(body: Record<string, unknown>): number | undefined {
  const v = optionalNumber(body, 'timeout_ms')
  return v === undefined ? undefined : Math.min(v, MAX_TIMEOUT_MS)
}

class BadRequest extends Error {}

async function runOp(
  sessions: SessionManager,
  id: string,
  op: string,
  body: Record<string, unknown>,
): Promise<browse.BrowseResult> {
  switch (op) {
    case 'navigate': {
      const url = need(body, 'url')
      const waitFor = optionalWaitFor(body)
      const timeoutMs = optionalTimeoutMs(body)
      return sessions.run(id, (p) => browse.navigate(p, url, { waitFor, timeoutMs }))
    }
    case 'snapshot':
      return sessions.run(id, (p) => browse.snapshot(p))
    case 'click':
      return sessions.run(id, (p) => browse.click(p, need(body, 'role'), need(body, 'name')))
    case 'type':
      return sessions.run(id, (p) =>
        browse.type(
          p,
          need(body, 'role'),
          need(body, 'name'),
          need(body, 'text'),
          body.submit === true,
        ),
      )
    case 'scroll': {
      const amount = optionalNumber(body, 'amount')
      return sessions.run(id, (p) =>
        browse.scroll(p, body.direction === 'up' ? 'up' : 'down', amount),
      )
    }
    case 'back':
      return sessions.run(id, (p) => browse.goBack(p))
    case 'select': {
      const values = needValues(body)
      return sessions.run(id, (p) =>
        browse.selectOption(p, need(body, 'role'), need(body, 'name'), values),
      )
    }
    case 'press':
      return sessions.run(id, (p) => browse.pressKey(p, need(body, 'key')))
    case 'wait': {
      const wf = needWaitFor(body)
      const timeoutMs = optionalTimeoutMs(body)
      return sessions.run(id, (p) => browse.waitFor(p, wf, timeoutMs))
    }
    default:
      throw new BadRequest(`unknown operation "${op}"`)
  }
}

function mapError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof SessionCapReached) {
    json(res, 429, { error: err.message, hint: 'close a session or retry' })
  } else if (err instanceof SessionNotFound) {
    json(res, 404, { error: err.message, hint: 'create a new session' })
  } else if (
    err instanceof browse.InvalidRoleError ||
    err instanceof BadRequest ||
    err instanceof BrowseArgError
  ) {
    json(res, 400, { error: (err as Error).message })
  } else {
    json(res, 502, { error: (err as Error).message })
  }
}
