import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './mcp-server.js'
import type { ToolDeclaration } from './core-compat.js'

const decls: ToolDeclaration[] = [
  {
    name: 'fetch_page',
    description: 'fetch',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({}),
  },
  {
    name: 'browse_wait',
    description: 'wait',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({}),
  },
]

async function connect(callTool: (n: string, a: Record<string, unknown>) => Promise<unknown>) {
  const server = createMcpServer({ toolDeclarations: decls, callTool })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(c)
  return client
}

describe('createMcpServer', () => {
  it('lists the tool declarations', async () => {
    const client = await connect(async () => ({}))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['browse_wait', 'fetch_page'])
  })

  it('routes callTool and wraps the result as text content', async () => {
    const client = await connect(async (name, args) => ({ echoed: name, args }))
    const res = await client.callTool({ name: 'fetch_page', arguments: { url: 'u' } })
    expect(JSON.parse((res.content as { type: string; text: string }[])[0].text)).toEqual({
      echoed: 'fetch_page',
      args: { url: 'u' },
    })
  })

  it('wraps a thrown tool error as an isError result, not a protocol error', async () => {
    class InvalidRoleError extends Error {}
    const client = await connect(async () => {
      throw new InvalidRoleError('invalid role: nope')
    })
    const res = await client.callTool({ name: 'fetch_page', arguments: {} })
    expect(res.isError).toBe(true)
    expect((res.content as { type: string; text: string }[])[0].text).toBe('invalid role: nope')
  })

  it('marks a result carrying a non-empty error as isError, keeping its JSON content', async () => {
    const failed = { url: 'u', method: 'browser', content: 'blocked', error: 'blocked by x' }
    const client = await connect(async () => failed)
    const res = await client.callTool({ name: 'fetch_page', arguments: { url: 'u' } })
    expect(res.isError).toBe(true)
    expect(JSON.parse((res.content as { type: string; text: string }[])[0].text)).toEqual(failed)
  })

  it('does not mark a successful result as isError', async () => {
    const client = await connect(async () => ({ url: 'u', content: 'ok' }))
    const res = await client.callTool({ name: 'fetch_page', arguments: { url: 'u' } })
    expect(res.isError).toBeFalsy()
  })
})
