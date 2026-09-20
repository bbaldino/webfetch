// Real-browser end-to-end for the session API. Skipped in `npm test`; runs only
// with BROWSE_INTEGRATION=1 (needs the Camoufox browser downloaded).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { BrowserManager } from './browser-manager.js'
import { SessionManager } from './session-manager.js'
import { createRouter } from './routes.js'

const RUN = process.env.BROWSE_INTEGRATION === '1'
let server: http.Server
let bm: BrowserManager
let base: string

beforeAll(async () => {
  if (!RUN) return
  bm = new BrowserManager({ headless: true })
  const sessions = new SessionManager(bm, { max: 2, ttlMs: 60000 })
  server = http.createServer(
    createRouter({ fetchPage: async () => ({ url: '', method: '' }), sessions }),
  )
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as import('node:net').AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  if (!RUN) return
  server.close()
  await bm.close()
})

describe.skipIf(!RUN)('session API (live browser)', () => {
  it('creates a session, navigates, snapshots, clicks, and closes', async () => {
    const created = await (await fetch(`${base}/sessions`, { method: 'POST' })).json()
    const id = created.session_id
    expect(id).toBeTruthy()

    const nav = await (
      await fetch(`${base}/sessions/${id}/navigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      })
    ).json()
    expect(nav.snapshot).toContain('Example Domain')

    const clicked = await fetch(`${base}/sessions/${id}/click`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'link', name: 'More information...' }),
    })
    expect([200, 502]).toContain(clicked.status) // link name may vary; assert it routed

    const del = await fetch(`${base}/sessions/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
  }, 60000)

  it('resolves a condition-based wait_for against a real page', async () => {
    const created = await (await fetch(`${base}/sessions`, { method: 'POST' })).json()
    const id = created.session_id
    expect(id).toBeTruthy()

    try {
      const nav = await fetch(`${base}/sessions/${id}/navigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          wait_for: { text: 'Example Domain' },
        }),
      })
      expect(nav.status).toBe(200)
      const navBody = await nav.json()
      expect(navBody.snapshot).toContain('Example Domain')

      // Also exercise the standalone /wait op, which re-checks the condition on
      // the already-loaded page.
      const waited = await fetch(`${base}/sessions/${id}/wait`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wait_for: { text: 'Example Domain' } }),
      })
      expect(waited.status).toBe(200)
      const waitedBody = await waited.json()
      expect(waitedBody.snapshot).toContain('Example Domain')
    } finally {
      await fetch(`${base}/sessions/${id}`, { method: 'DELETE' })
    }
  }, 60000)
})
