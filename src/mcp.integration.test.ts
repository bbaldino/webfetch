// Real-browser end-to-end for the /mcp face. Skipped in `npm test`; runs only
// with MCP_INTEGRATION=1 (needs the Camoufox browser downloaded). Mirrors
// browse-sessions.integration.test.ts, but drives the server over an actual
// MCP client (Streamable HTTP) instead of the raw /sessions REST API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runMigrations } from './core-compat.js'
import { BrowserManager } from './browser-manager.js'
import { DomainDb } from './domain-db.js'
import { createTools } from './tools.js'
import { SessionManager } from './session-manager.js'
import { createRouter } from './routes.js'
import { McpFace } from './mcp-http.js'

const RUN = process.env.MCP_INTEGRATION === '1'
let server: http.Server
let bm: BrowserManager
let mcp: McpFace
let client: Client
let base: string

beforeAll(async () => {
  if (!RUN) return
  bm = new BrowserManager({ headless: true })
  const db = new Database(':memory:')
  runMigrations(db, import.meta.url)
  const domainDb = new DomainDb({ raw: db })

  const tools = createTools(bm, domainDb)
  const fetchPage = tools.find((t) => t.name === 'fetch_page')
  if (!fetchPage) throw new Error('fetch_page tool not found')

  const sessions = new SessionManager(bm, { max: 2, ttlMs: 60000 })
  mcp = new McpFace({ sessions, fetchPage, toolDeclarations: tools })

  server = http.createServer(
    createRouter({
      fetchPage: (args, ctx) => fetchPage.handler(args, ctx as never) as never,
      sessions,
      mcp,
    }),
  )
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as import('node:net').AddressInfo
  base = `http://127.0.0.1:${port}`

  client = new Client({ name: 'mcp-integration-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
  await client.connect(transport)
}, 60000)

afterAll(async () => {
  if (!RUN) return
  await client.close()
  await mcp.closeAll()
  await new Promise<void>((r) => server.close(() => r()))
  await bm.close()
})

describe.skipIf(!RUN)('MCP over HTTP (live browser)', () => {
  it('navigates and reads a snapshot via browse_navigate', async () => {
    const result = await client.callTool({
      name: 'browse_navigate',
      arguments: { url: 'https://example.com' },
    })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]?.type).toBe('text')
    const parsed = JSON.parse(content[0].text) as { snapshot: string }
    expect(parsed.snapshot).toContain('Example Domain')
  }, 60000)

  it('fetches a page via fetch_page', async () => {
    const result = await client.callTool({
      name: 'fetch_page',
      arguments: { url: 'https://example.com' },
    })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.text?.length).toBeGreaterThan(0)
  }, 60000)

  it('resolves a condition-based wait_for via browse_wait', async () => {
    const result = await client.callTool({
      name: 'browse_wait',
      arguments: { wait_for: { text: 'Example Domain' } },
    })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    const parsed = JSON.parse(content[0].text) as { snapshot: string }
    expect(parsed.snapshot).toContain('Example Domain')
  }, 60000)
})
