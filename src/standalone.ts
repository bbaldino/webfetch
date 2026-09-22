// Standalone stdio MCP server for the webfetch tools — no agent runtime.
//
// This exposes the browse tools (`fetch_page`, `browse_*`) as an ordinary MCP
// server, for MCP clients (agents, the browse-bench harness) that want the full
// interactive surface rather than the one-shot REST `/fetch`. There is no agent,
// event bus, or admin UI — just the tool declarations from `createTools`, backed
// by a real `BrowserManager` and a `DomainDb`.
//
// IMPORTANT: stdout is the JSON-RPC transport. ALL logging MUST go to stderr
// (`console.error`) — never `console.log`/stdout — or it corrupts the protocol.
import Database from 'better-sqlite3'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { runMigrations, type ToolContext } from './core-compat.js'
import { BrowserManager } from './browser-manager.js'
import { CookieJar } from './cookie-jar.js'
import { setJarCoverage } from './detect-block.js'
import { DomainDb } from './domain-db.js'
import { createTools } from './tools.js'
import { createMcpServer } from './mcp-server.js'

const headless = process.env.WEBFETCH_HEADLESS !== 'false'
// Cookies exported from a real browser (npm run export-cookies); missing file = empty jar.
const jar = new CookieJar(process.env.WEBFETCH_COOKIE_JAR ?? '/data/cookies.json')
setJarCoverage((host) => jar.covers(host))
const browserManager = new BrowserManager({ headless, jar })

// Plugin DB: defaults to in-memory. The webfetch SQL migrations create the
// `domain_stats` / `domain_config` tables that DomainDb reads and writes.
const db = new Database(process.env.WEBFETCH_DB ?? ':memory:')
runMigrations(db, import.meta.url)

// DomainDb wraps a PluginDatabase ({ raw: <better-sqlite3 handle> }).
const domainDb = new DomainDb({ raw: db })

const tools = createTools(browserManager, domainDb)
const byName = new Map(tools.map((t) => [t.name, t]))

// The webfetch handlers only touch ctx via getRunId (agentName/channelId),
// which are optional and fall back to a single default session. Supply a
// minimal ToolContext so the shape is satisfied without an agent runtime.
const server = createMcpServer({
  name: 'webfetch',
  version: '0.1.0',
  toolDeclarations: tools,
  callTool: async (name, args) => {
    const tool = byName.get(name)
    if (!tool) {
      throw new Error(`unknown tool: ${name}`)
    }
    const ctx: ToolContext = {
      credentials: {},
      fetch: globalThis.fetch,
    }
    return tool.handler(args, ctx)
  },
})

async function shutdown(): Promise<void> {
  try {
    await browserManager.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
console.error('webfetch standalone MCP ready on stdio')
