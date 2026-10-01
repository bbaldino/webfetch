import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTools, isContentUsable, capRedditContent, REDDIT_OUTPUT_CAP } from './tools.js'
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

describe('capRedditContent (I1)', () => {
  it('leaves short content untouched', () => {
    expect(capRedditContent('hello', 'https://www.reddit.com/r/t/comments/1/x/')).toBe('hello')
  })

  it('cuts long content on a line boundary and appends a truncation pointer', () => {
    // 60,000 characters across many short lines.
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${i} 0123456789`)
    const content = lines.join('\n')
    const url = 'https://www.reddit.com/r/t/comments/1/x/'
    const out = capRedditContent(content, url)
    expect(out.length).toBeLessThan(content.length)
    const kept = out.slice(0, out.lastIndexOf('\n[truncated'))
    // The cut lands on a line boundary: every kept line is intact, none
    // chopped mid-line.
    expect(kept.split('\n').every((l) => l === '' || lines.includes(l))).toBe(true)
    expect(kept.length).toBeLessThanOrEqual(REDDIT_OUTPUT_CAP)
    const droppedChars = content.length - kept.length
    expect(
      out.endsWith(`[truncated — ${droppedChars} more characters; the full thread is at ${url}]`),
    ).toBe(true)
  })
})

describe('fetch_page handler Reddit output cap (I1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  const ctx = {} as ToolContext
  const fakeDb = () => ({
    getPreferredMethod: vi.fn(() => 'auto'),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  })
  const fetchPage = (db: unknown) =>
    createTools({} as never, db as never).find((t) => t.name === 'fetch_page')!

  it('caps a huge Redlib thread at 50,000 characters with a reddit.com pointer', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    const commentsHtml = Array.from(
      { length: 3000 },
      (_, i) =>
        `<div id="c${i}" class="comment"><div class="comment_left"><p class="comment_score" title="1">1</p>` +
        `<div class="line"></div></div><details class="comment_right" open><summary class="comment_data">` +
        `<a class="comment_author" href="/user/u${i}">u/u${i}</a></summary><div class="comment_body">` +
        `<div class="md"><p>Comment number ${i} with some filler text to pad it out a bit more.</p></div></div></details></div>`,
    ).join('\n')
    const html = `<html><body><main>
<div class="post highlighted">
  <p class="post_header"><a class="post_subreddit" href="/r/t">r/t</a><a class="post_author" href="/user/op">u/op</a></p>
  <h1 class="post_title">Big thread</h1>
  <div class="post_body"><div class="md"><p>Body</p></div></div>
  <div class="post_score" title="1">1</div>
</div>
<div class="thread">${commentsHtml}</div>
</main></body></html>`
    vi.stubGlobal('fetch', async () => new Response(html, { status: 200 }))
    const db = fakeDb()
    const r = (await fetchPage(db).handler(
      { url: 'https://www.reddit.com/r/t/comments/1/x/' },
      ctx,
    )) as { content: string }
    expect(r.content.length).toBeLessThan(html.length)
    expect(r.content).toMatch(
      /\[truncated — \d+ more characters; the full thread is at https:\/\/www\.reddit\.com\/r\/t\/comments\/1\/x\/\]$/,
    )
    // The cut landed on a line boundary: no partial comment line survives.
    expect(r.content).not.toContain('Comment number 2999')
  })

  it('does not touch an RSS-tier Reddit result, which is already well under the cap', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', '')
    const rss = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><category term="t" label="r/t"/><title>Small post : t</title><entry><author><name>/u/op</name></author><title>Small post</title><content type="html">&lt;p&gt;Short body.&lt;/p&gt;</content></entry></feed>`
    vi.stubGlobal('fetch', async () => new Response(rss, { status: 200 }))
    const db = fakeDb()
    const r = (await fetchPage(db).handler(
      { url: 'https://www.reddit.com/r/t/comments/1/x/' },
      ctx,
    )) as { content: string }
    expect(r.content).toContain('# Small post')
    expect(r.content).not.toContain('truncated')
  })
})
