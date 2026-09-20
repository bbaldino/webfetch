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
//
// This file is bootstrap only: it constructs the singletons and hands them to createRouter. The
// actual request handling lives in routes.ts, which has no module-level side effects and can be
// unit tested without a browser.
import http from 'node:http'
import Database from 'better-sqlite3'
import { runMigrations } from './core-compat.js'
import { BrowserManager } from './browser-manager.js'
import { DomainDb } from './domain-db.js'
import { createTools } from './tools.js'
import { SessionManager } from './session-manager.js'
import { createRouter } from './routes.js'

const port = Number(process.env.PORT ?? 9000)
const headless = process.env.WEBFETCH_HEADLESS !== 'false'
const maxSessions = Number(process.env.WEBFETCH_MAX_SESSIONS ?? 3)
const sessionTtlMs = Number(process.env.WEBFETCH_SESSION_TTL_MS ?? 300000)

const browserManager = new BrowserManager({ headless })
const db = new Database(process.env.WEBFETCH_DB ?? ':memory:')
runMigrations(db, import.meta.url)
const domainDb = new DomainDb({ raw: db })

const tools = createTools(browserManager, domainDb)
const fetchPage = tools.find((t) => t.name === 'fetch_page')
if (!fetchPage) throw new Error('fetch_page tool not found')

const sessions = new SessionManager(browserManager, { max: maxSessions, ttlMs: sessionTtlMs })

const server = http.createServer(
  createRouter({
    fetchPage: (args, ctx) => fetchPage.handler(args, ctx as never) as never,
    sessions,
  }),
)

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
