import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTools, isContentUsable } from './tools.js'
import type { ToolContext } from './core-compat.js'

describe('isContentUsable', () => {
  const pad = (s: string, n: number) => s + ' lorem'.repeat(Math.ceil(n / 6))

  it('rejects very short content', () => {
    expect(isContentUsable('hello')).toBe(false)
  })
  it('rejects a short page that matches a block pattern', () => {
    expect(isContentUsable(pad('Just a moment... checking your browser', 400))).toBe(false)
    expect(isContentUsable(pad('Please complete the captcha to continue', 1500))).toBe(false)
  })
  it('accepts a long page that merely mentions a pattern', () => {
    expect(isContentUsable(pad('Protected by Cloudflare.', 3000))).toBe(true)
  })
  it('accepts an ordinary page', () => {
    expect(isContentUsable(pad('An ordinary article about gardening.', 400))).toBe(true)
  })
})

describe('fetch_page handler', () => {
  afterEach(() => vi.unstubAllGlobals())

  // A browser page that renders a DataDome captcha wall.
  const blockedBrowser = () => {
    const page = {
      goto: async () => ({ status: () => 403 }),
      waitForTimeout: async () => {},
      innerText: async () => '',
      content: async () => '',
      title: async () => 'yelp.com',
      url: () => 'https://www.yelp.com/biz/x',
      frames: () => [{ url: () => 'https://geo.captcha-delivery.com/captcha/?x=1' }],
    }
    return {
      createTempPage: vi.fn(async () => ({ context: {}, page })),
      closeContext: vi.fn(async () => {}),
    }
  }
  const fakeDb = (preferred: string) => ({
    getPreferredMethod: vi.fn(() => preferred),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  })
  const ctx = {} as ToolContext

  const fetchPage = (bm: unknown, db: unknown) =>
    createTools(bm as never, db as never).find((t) => t.name === 'fetch_page')!

  it('a blocked browser-only fetch returns an error and records a browser failure', async () => {
    const bm = blockedBrowser()
    const db = fakeDb('browser')
    const r = (await fetchPage(bm, db).handler({ url: 'https://www.yelp.com/biz/x' }, ctx)) as {
      error?: string
    }
    expect(r.error).toMatch(/blocked by yelp\.com's bot protection/)
    expect(db.recordFailure).toHaveBeenCalledWith('yelp.com', 'browser')
    expect(db.recordSuccess).not.toHaveBeenCalled()
    expect(bm.closeContext).toHaveBeenCalledOnce()
  })

  it('a blocked browser fallback returns an error and records a browser failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('Forbidden', { status: 403 }))
    const bm = blockedBrowser()
    const db = fakeDb('auto')
    const r = (await fetchPage(bm, db).handler({ url: 'https://www.yelp.com/biz/x' }, ctx)) as {
      error?: string
      method: string
    }
    expect(r.method).toBe('browser (fallback)')
    expect(r.error).toBeTruthy()
    expect(db.recordFailure).toHaveBeenCalledWith('yelp.com', 'fetch')
    expect(db.recordFailure).toHaveBeenCalledWith('yelp.com', 'browser')
  })
})
