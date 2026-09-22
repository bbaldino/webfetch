import { describe, it, expect } from 'vitest'
import { McpFace, parseAllowedHosts } from './mcp-http.js'
import { SessionCapReached, SessionNotFound } from './session-manager.js'
import type { ToolDeclaration } from './core-compat.js'

const fetchPage: ToolDeclaration = {
  name: 'fetch_page',
  description: 'f',
  inputSchema: { type: 'object', properties: {} },
  handler: async (args) => ({ url: (args as { url: string }).url, method: 'stub' }),
}

function mockPage() {
  const loc = {
    first() {
      return this
    },
    click: async () => {},
    ariaSnapshot: async () => '- doc',
  }
  return {
    goto: async () => {},
    url: () => 'https://e/',
    title: async () => 'E',
    locator: () => loc,
    getByRole: () => loc,
  }
}

function stubSessions(overrides: Record<string, unknown> = {}) {
  return {
    createCalls: 0,
    async create() {
      this.createCalls++
      return { id: `bs-${this.createCalls}`, expiresInMs: 1000 }
    },
    async run(_id: string, fn: (p: unknown) => Promise<unknown>) {
      return fn(mockPage())
    },
    async close() {},
    size: 0,
    ...overrides,
  }
}

describe('McpFace.makeCallTool', () => {
  it('runs fetch_page via the tool handler', async () => {
    const face = new McpFace({
      sessions: stubSessions() as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    const call = face.makeCallTool('m1')
    expect(await call('fetch_page', { url: 'u' })).toMatchObject({ url: 'u', method: 'stub' })
  })

  it('lazily creates one browse session and reuses it', async () => {
    const sessions = stubSessions()
    const face = new McpFace({
      sessions: sessions as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    const call = face.makeCallTool('m1')
    await call('browse_navigate', { url: 'https://e' })
    await call('browse_snapshot', {})
    expect(sessions.createCalls).toBe(1)
  })

  it('retries once on SessionNotFound (idle eviction)', async () => {
    let calls = 0
    const sessions = stubSessions({
      async run(_id: string, fn: (p: unknown) => Promise<unknown>) {
        calls++
        if (calls === 1) throw new SessionNotFound('bs-1')
        return fn(mockPage())
      },
    })
    const face = new McpFace({
      sessions: sessions as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    const r = await face.makeCallTool('m1')('browse_snapshot', {})
    expect(r).toMatchObject({ title: 'E' })
    expect(sessions.createCalls).toBe(2)
  })

  it('propagates SessionCapReached', async () => {
    const sessions = stubSessions({
      async create() {
        throw new SessionCapReached(3)
      },
    })
    const face = new McpFace({
      sessions: sessions as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    await expect(face.makeCallTool('m1')('browse_snapshot', {})).rejects.toBeInstanceOf(
      SessionCapReached,
    )
  })
})

describe('parseAllowedHosts', () => {
  const DEFAULT = ['webfetch.home', '127.0.0.1:9000', 'localhost:9000']

  it('undefined raw with DNS enabled falls back to the default list', () => {
    expect(parseAllowedHosts(undefined, true)).toEqual(DEFAULT)
  })

  it('empty string raw with DNS enabled falls back to the default list', () => {
    expect(parseAllowedHosts('', true)).toEqual(DEFAULT)
  })

  it('drops empty entries from a comma-separated list', () => {
    expect(parseAllowedHosts('a,,b', true)).toEqual(['a', 'b'])
  })

  it('DNS disabled always returns undefined, regardless of raw', () => {
    expect(parseAllowedHosts('a,b', false)).toBeUndefined()
    expect(parseAllowedHosts(undefined, false)).toBeUndefined()
  })

  it('drops a trailing empty entry from a trailing comma', () => {
    expect(parseAllowedHosts('webfetch.home,', true)).toEqual(['webfetch.home'])
  })
})
