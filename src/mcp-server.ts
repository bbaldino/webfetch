import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDeclaration } from './core-compat.js'

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>

export function createMcpServer(opts: {
  toolDeclarations: ToolDeclaration[]
  callTool: ToolCaller
  name?: string
  version?: string
}): Server {
  const server = new Server(
    { name: opts.name ?? 'webfetch', version: opts.version ?? '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.toolDeclarations.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await opts.callTool(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      )
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: message }], isError: true }
    }
  })

  return server
}
