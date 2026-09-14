// HTTP REST frontend for webfetch — a networked face over the same `fetch_page` tool the stdio
// MCP `standalone.ts` exposes. Lets non-MCP clients (e.g. raven-rs's `webfetch` plugin) fetch a
// page over plain HTTP:
//
//   POST /fetch  { "url": "..." }  ->  200 { "title", "text", "final_url", "method" }
//                                       502 { "error" } on a fetch failure
//   GET  /health ->  200 { "status": "ok" }
//
// Backed by a real BrowserManager + DomainDb, so it gets the full tiered fetch (direct HTTP ->
// browser fallback), the Reddit chain, and per-domain method learning.
import http from 'node:http'
import Database from 'better-sqlite3'
import { runMigrations } from './core-compat.js'
import { BrowserManager } from './browser-manager.js'
import { DomainDb } from './domain-db.js'
import { createTools } from './tools.js'

const port = Number(process.env.PORT ?? 9000)
const headless = process.env.WEBFETCH_HEADLESS !== 'false'

const browserManager = new BrowserManager({ headless })
const db = new Database(process.env.WEBFETCH_DB ?? ':memory:')
runMigrations(db, import.meta.url)
const domainDb = new DomainDb({ raw: db })

const tools = createTools(browserManager, domainDb)
const fetchPage = tools.find((t) => t.name === 'fetch_page')
if (!fetchPage) throw new Error('fetch_page tool not found')

interface FetchResult {
  url: string
  method: string
  title?: string
  content?: string
  error?: string
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
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { status: 'ok' })
      return
    }
    if (req.method === 'POST' && req.url === '/fetch') {
      const body = await readBody(req)
      let url: unknown
      try {
        url = (JSON.parse(body || '{}') as { url?: unknown }).url
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
      const result = (await fetchPage.handler({ url }, ctx as never)) as FetchResult
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
    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 500, { error: (err as Error).message })
  }
})

async function shutdown(): Promise<void> {
  server.close()
  try {
    await browserManager.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(port, () => {
  console.error(`webfetch server listening on :${port}`)
})
