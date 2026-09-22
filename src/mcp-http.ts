// The HTTP MCP face: a networked MCP endpoint (Streamable HTTP transport) sitting
// alongside the REST `/fetch` face and the stdio `standalone.ts` server. Each MCP
// client (identified by its `Mcp-Session-Id`) gets its own `StreamableHTTPServerTransport`
// + `Server` pair, and — lazily, on first `browse_*` call — its own capped browser
// session from `SessionManager`.
//
// The browse-session id is kept in its OWN map (`browseSessions`), separate from the
// transport-entry map. This lets `makeCallTool`/`runBrowse` be unit tested directly
// (no live transport needed) and keeps browse-session lifecycle decoupled from
// transport lifecycle.
import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer, type ToolCaller } from './mcp-server.js'
import { callBrowseTool, BROWSE_TOOL_OPS } from './browse-tools.js'
import { SessionNotFound, type SessionManager } from './session-manager.js'
import type { ToolDeclaration } from './core-compat.js'

interface Entry {
  transport: StreamableHTTPServerTransport
  server: ReturnType<typeof createMcpServer>
}

export interface McpFaceDeps {
  sessions: SessionManager
  fetchPage: ToolDeclaration
  toolDeclarations: ToolDeclaration[]
  allowedHosts?: string[]
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const DEFAULT_ALLOWED_HOSTS = ['webfetch.home', '127.0.0.1:9000', 'localhost:9000']

/**
 * Parse the `WEBFETCH_MCP_ALLOWED_HOSTS` env value into the `allowedHosts` list
 * `McpFace` expects, given whether DNS-rebinding protection is enabled
 * (`WEBFETCH_MCP_DNS_REBINDING`, false/0 = disabled). Pure — no env access here,
 * so it's directly testable. Blank/whitespace-only entries (and an unset or
 * empty `raw`) fall back to the default LAN host list; `dnsEnabled: false`
 * always returns `undefined` (disables the check entirely), matching the
 * escape hatch documented in `server.ts`.
 */
export function parseAllowedHosts(
  raw: string | undefined,
  dnsEnabled: boolean,
): string[] | undefined {
  if (!dnsEnabled) return undefined
  const hosts = (raw ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  return hosts.length ? hosts : DEFAULT_ALLOWED_HOSTS
}

export class McpFace {
  // Transport/server per MCP client session (keyed by Mcp-Session-Id).
  private entries = new Map<string, Entry>()
  // Browse (browser) session id per MCP client session — owned separately so
  // makeCallTool/runBrowse work standalone, without a live transport entry.
  private browseSessions = new Map<string, string>()

  constructor(private deps: McpFaceDeps) {}

  /** Build the per-client CallTool dispatcher for `createMcpServer`. */
  makeCallTool(mcpSessionId: string): ToolCaller {
    return async (name, args) => {
      if (name === 'fetch_page') {
        return this.deps.fetchPage.handler(args, {
          credentials: {},
          fetch: globalThis.fetch,
        } as never)
      }
      if (name in BROWSE_TOOL_OPS) {
        return callBrowseTool(name, args, (fn) => this.runBrowse(mcpSessionId, fn))
      }
      throw new Error(`unknown tool: ${name}`)
    }
  }

  /**
   * Run `fn` against this client's browse session, creating it lazily on first
   * use. If the session was idle-evicted (`SessionNotFound`), clear the stale id,
   * create a fresh session once, and retry. `SessionCapReached` propagates
   * unchanged (createMcpServer's CallTool try/catch turns it into an isError
   * result).
   */
  private async runBrowse<T>(mcpSessionId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const ensureBrowseId = async (): Promise<string> => {
      const existing = this.browseSessions.get(mcpSessionId)
      if (existing) return existing
      const { id } = await this.deps.sessions.create()
      this.browseSessions.set(mcpSessionId, id)
      return id
    }

    const id = await ensureBrowseId()
    try {
      return await this.deps.sessions.run(id, fn)
    } catch (err) {
      if (err instanceof SessionNotFound) {
        this.browseSessions.delete(mcpSessionId)
        const retryId = await ensureBrowseId()
        return this.deps.sessions.run(retryId, fn)
      }
      throw err
    }
  }

  /** Close this client's browse session, if any, and forget it. */
  private async closeBrowseSession(mcpSessionId: string): Promise<void> {
    const browseId = this.browseSessions.get(mcpSessionId)
    this.browseSessions.delete(mcpSessionId)
    if (browseId) await this.deps.sessions.close(browseId)
  }

  /**
   * Streamable HTTP transport lifecycle. On an initialize POST (no
   * `Mcp-Session-Id` header, body is an initialize request) create a fresh
   * transport+server pair; otherwise dispatch to the existing transport for the
   * given session id. Unknown/missing session id on a non-initialize request
   * gets a JSON 404 (matches the transport's own "unknown session" shape).
   */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, body?: unknown): Promise<void> {
    const sessionIdHeader = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader

    if (!sessionId) {
      if (req.method === 'POST' && isInitializeRequest(body)) {
        await this.initializeSession(req, res, body)
        return
      }
      json(res, 404, { error: 'missing Mcp-Session-Id header' })
      return
    }

    const entry = this.entries.get(sessionId)
    if (!entry) {
      json(res, 404, { error: `unknown session: ${sessionId}` })
      return
    }
    await entry.transport.handleRequest(req, res, body)
  }

  private async initializeSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ): Promise<void> {
    // The transport generates the session id internally (via sessionIdGenerator),
    // but createMcpServer's callTool needs that id up front to key browse
    // sessions — and the Server must be connect()ed to the transport BEFORE
    // handleRequest() runs, so the transport has somewhere to dispatch the
    // incoming initialize message. Resolving this: generate the id ourselves
    // and hand the transport a fixed `sessionIdGenerator: () => id`, so the
    // "generated" id is known before the transport (and the Server built on
    // top of it) is even constructed.
    const id = randomUUID()

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: (sid) => {
        this.entries.set(sid, { transport, server })
      },
      onsessionclosed: async (sid) => {
        await this.closeBrowseSession(sid)
        this.entries.delete(sid)
      },
      enableDnsRebindingProtection: this.deps.allowedHosts !== undefined,
      allowedHosts: this.deps.allowedHosts,
    })

    const server = createMcpServer({
      toolDeclarations: this.deps.toolDeclarations,
      callTool: this.makeCallTool(id),
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /** Close every transport + browse session — for server shutdown. */
  async closeAll(): Promise<void> {
    const ids = [...this.entries.keys()]
    await Promise.all(
      ids.map(async (id) => {
        const entry = this.entries.get(id)
        this.entries.delete(id)
        await this.closeBrowseSession(id)
        if (entry) {
          try {
            await entry.transport.close()
          } catch {
            // best-effort on shutdown
          }
        }
      }),
    )
  }
}
