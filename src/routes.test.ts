import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createRouter, type RouterDeps } from './routes.js'
import { SessionCapReached, SessionNotFound } from './session-manager.js'

let server: http.Server | undefined
afterEach(() => server?.close())

async function start(deps: RouterDeps): Promise<string> {
  server = http.createServer(createRouter(deps))
  await new Promise<void>((r) => server!.listen(0, r))
  const { port } = server!.address() as import('node:net').AddressInfo
  return `http://127.0.0.1:${port}`
}

const stubDeps = (): RouterDeps => ({
  fetchPage: async ({ url }) => ({ url, method: 'stub', title: 'T', content: 'C' }),
  sessions: {} as never,
})

describe('createRouter', () => {
  it('GET /health returns ok', async () => {
    const base = await start(stubDeps())
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('POST /fetch returns the tool result', async () => {
    const base = await start(stubDeps())
    const res = await fetch(`${base}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.test' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ title: 'T', text: 'C', method: 'stub' })
  })

  it('unknown route returns 404 with a hint', async () => {
    const base = await start(stubDeps())
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
    expect((await res.json()).hint).toContain('/fetch')
  })
})

function sessionStub() {
  const mockPage = {
    goto: async () => {},
    url: () => 'https://example.com/',
    title: async () => 'Example',
    locator: () => ({ ariaSnapshot: async () => '- document' }),
    getByRole: () => ({ first: () => ({ click: async () => {}, fill: async () => {} }) }),
  }
  return {
    created: [] as string[],
    async create() {
      this.created.push('x')
      if (this.created.length > 1) throw new SessionCapReached(1)
      return { id: 'sess-1', expiresInMs: 300000 }
    },
    async run(id: string, fn: (p: unknown) => Promise<unknown>) {
      if (id !== 'sess-1') throw new SessionNotFound(id)
      return fn(mockPage)
    },
    async close() {},
    size: 0,
  }
}

describe('session routes', () => {
  it('POST /sessions returns 201 + id', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions`, { method: 'POST' })
    expect(res.status).toBe(201)
    expect((await res.json()).session_id).toBe('sess-1')
  })

  it('POST /sessions returns 429 at cap', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    await fetch(`${base}/sessions`, { method: 'POST' })
    const res = await fetch(`${base}/sessions`, { method: 'POST' })
    expect(res.status).toBe(429)
  })

  it('navigate on an unknown session returns 404', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/ghost/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.test' }),
    })
    expect(res.status).toBe(404)
  })

  it('navigate returns the envelope', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ url: 'https://example.com/', title: 'Example' })
  })

  it('missing url on navigate returns 400', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('missing values on select returns 400', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'combobox', name: 'Choice' }),
    })
    expect(res.status).toBe(400)
  })

  it('missing wait_for on wait returns 400, not 502', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('invalid wait_for on navigate returns 400, not 502', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.test', wait_for: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('non-numeric timeout_ms on navigate returns 400', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.test', timeout_ms: 'soon' }),
    })
    expect(res.status).toBe(400)
  })
})
