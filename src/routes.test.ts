import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createRouter, type RouterDeps } from './routes.js'

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
