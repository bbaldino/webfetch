import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseRedditRss,
  looksBlocked,
  tryRssFeed,
  tryFeedFetcher,
  extractRedditPageText,
  fetchReddit,
  tryRedlib,
  redlibTarget,
} from './reddit.js'

// A minimal but structurally-faithful Reddit per-post Atom feed: feed title is
// "<post> : <sub>", the first <entry> is the post (selftext in <content>), and
// later entries are comments titled "/u/<author> on <post>". <content> holds
// XML-escaped HTML.
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><category term="testsub" label="r/testsub"/><title>My Great Post : testsub</title><entry><author><name>/u/op</name></author><title>My Great Post</title><content type="html">&lt;div class="md"&gt;&lt;p&gt;This is the post body with &amp;#39;quotes&amp;#39;.&lt;/p&gt;&lt;/div&gt;</content></entry><entry><author><name>/u/alice</name></author><title>/u/alice on My Great Post</title><content type="html">&lt;p&gt;Nice work!&lt;/p&gt;</content></entry></feed>`

describe('parseRedditRss', () => {
  it('extracts the post title, subreddit, selftext, and comments', () => {
    const { title, content } = parseRedditRss(SAMPLE_RSS)
    expect(title).toBe('My Great Post')
    expect(content).toContain('# My Great Post')
    expect(content).toContain('r/testsub')
    // selftext, with XML/HTML entities decoded
    expect(content).toContain("This is the post body with 'quotes'.")
    // comments section, keyed by author
    expect(content).toContain('## Comments')
    expect(content).toContain('[/u/alice]')
    expect(content).toContain('Nice work!')
    // the post entry is not mistaken for a comment
    expect(content).not.toContain('[/u/op]')
  })
})

describe('looksBlocked', () => {
  it('flags 403/429 and empty bodies', () => {
    expect(looksBlocked(403, 'anything')).toBe(true)
    expect(looksBlocked(429, 'anything')).toBe(true)
    expect(looksBlocked(200, '   ')).toBe(true)
  })

  it('flags the "Welcome to Reddit" login wall by its title', () => {
    const wall =
      '<html><head><title>Welcome to Reddit</title></head><body>' +
      'x'.repeat(400) +
      '</body></html>'
    expect(looksBlocked(200, wall)).toBe(true)
  })

  it('does not flag a real RSS feed or a real post page', () => {
    expect(looksBlocked(200, SAMPLE_RSS)).toBe(false)
    // a real post page contains a login link + theme-beta but its own title
    const realPage =
      '<html><head><title>My Great Post : homeassistant</title></head><body class="theme-beta">Log in ... ' +
      'y'.repeat(400) +
      '</body></html>'
    expect(looksBlocked(200, realPage)).toBe(false)
  })
})

// Reddit serves this Atom feed with an HTTP 404 for a post it can't resolve
// (deleted/removed post, or a share link that didn't resolve). The body is a
// structurally-valid feed — long enough and without any block marker — so the
// ONLY signal that it isn't real content is the 404 status. Kept >200 chars so
// looksBlocked's short-body heuristic can't be what catches it.
const NOT_FOUND_RSS = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><category term="homeassistant" label="r/homeassistant"/><title>homeassistant: page not found</title><link href="https://www.reddit.com/r/homeassistant/comments/deleted/"/><updated>2026-09-16T00:00:00+00:00</updated><id>https://www.reddit.com/r/homeassistant/.rss</id></feed>`

function mockFetch(status: number, body: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    url: 'https://www.reddit.com/r/x/comments/1/x.rss',
    text: async () => body,
  } as Response)
}

describe('tryRssFeed', () => {
  afterEach(() => vi.restoreAllMocks())

  it('treats a Reddit HTTP 404 as a failure even when the body is a valid feed', async () => {
    mockFetch(404, NOT_FOUND_RSS)
    const r = await tryRssFeed(
      'https://www.reddit.com/r/homeassistant/comments/1whrolb/made_ha_my_running_coach_and_app/',
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('404')
    // must NOT surface Reddit's "page not found" placeholder as content
    expect(r.content).toBe('')
  })

  it('parses a 200 feed into structured post content', async () => {
    mockFetch(200, SAMPLE_RSS)
    const r = await tryRssFeed('https://www.reddit.com/r/testsub/comments/1/my_great_post/')
    expect(r.ok).toBe(true)
    expect(r.content).toContain('# My Great Post')
  })
})

// A structurally-faithful shreddit (new-reddit SSR) page: the real post + comment
// tree live inside id="main-content", wrapped by the site header, footer, and a
// "more posts" rail — the chrome that pollutes a naive whole-body text strip.
// Tailwind arbitrary-variant class tokens (`[&>:first-child]:h-full`) also leak
// into the stripped text and must be scrubbed.
const POST_BODY =
  'This is the actual post body. I built a running coach in Home Assistant that ' +
  'syncs data from my watch through Intervals.icu and asks Gemini for a plan.'
const SHREDDIT_PAGE = `<html><head><title>Made HA my Running Coach : r/homeassistant</title></head><body>
<header>Skip to main content Open menu Open navigation Go to Reddit Home Sign Up Sign up for Reddit Log In Log in to Reddit</header>
<div id="main-content" class="[&>:first-child]:h-full h-full w-full">
  <shreddit-post><h1>Made HA my Running Coach</h1><div slot="text-body"><p>${POST_BODY}</p></div></shreddit-post>
  <div id="comment-tree"><shreddit-comment><p>Great writeup, thanks for sharing the workflow details!</p></shreddit-comment></div>
</div>
<footer>RESOURCES About Reddit Advertise Developer Platform Reddit Pro BETA Help Blog Careers Press Reddit, Inc. © 2026. All rights reserved.</footer>
</body></html>`

// The same shell after Reddit declined to SSR the content (JS-gated / rate-limited):
// header + footer chrome, but id="main-content" holds only a loading skeleton.
const CHROME_ONLY_PAGE = `<html><head><title>Some Post : r/homeassistant</title></head><body>
<header>Skip to main content Open menu Open navigation Go to Reddit Home Sign Up Log In</header>
<div id="main-content"><div class="loading [&>:first-child]:h-full"></div></div>
<footer>RESOURCES About Reddit Advertise Developer Platform Reddit, Inc. © 2026. All rights reserved.</footer>
</body></html>`

describe('extractRedditPageText', () => {
  it('recovers the post + comments from #main-content and drops the chrome', () => {
    const text = extractRedditPageText(SHREDDIT_PAGE)
    expect(text).toContain('actual post body')
    expect(text).toContain('Great writeup')
    // site chrome must not survive
    expect(text).not.toContain('Skip to main content')
    expect(text).not.toContain('RESOURCES About Reddit')
    // Tailwind class-token garbage must be scrubbed
    expect(text).not.toContain('[&>')
    expect(text).not.toContain('h-full')
    // the region's own closing tag must not leak in as text
    expect(text).not.toContain('</')
  })

  it('yields near-nothing for a chrome-only shell with an empty #main-content', () => {
    const text = extractRedditPageText(CHROME_ONLY_PAGE)
    expect(text.length).toBeLessThan(200)
  })
})

describe('tryFeedFetcher content recovery', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the recovered post content, not the nav chrome', async () => {
    mockFetch(200, SHREDDIT_PAGE)
    const r = await tryFeedFetcher(
      'https://www.reddit.com/r/homeassistant/comments/1whrolb/made_ha_my_running_coach_and_app/',
    )
    expect(r.ok).toBe(true)
    expect(r.content).toContain('actual post body')
    expect(r.content).not.toContain('Skip to main content')
  })

  it('fails on a chrome-only shell instead of returning it as success', async () => {
    mockFetch(200, CHROME_ONLY_PAGE)
    const r = await tryFeedFetcher(
      'https://www.reddit.com/r/homeassistant/comments/1whrolb/made_ha_my_running_coach_and_app/',
    )
    expect(r.ok).toBe(false)
    expect(r.content).toBe('')
  })
})

const REDLIB_POST = `<div class="post highlighted"><p class="post_header"><a class="post_subreddit" href="/r/t">r/t</a><a class="post_author" href="/user/op">u/op</a></p><h1 class="post_title">Hello</h1><div class="post_body"><div class="md"><p>Body</p></div></div><div class="post_score" title="3">3</div></div><div class="thread"></div>`

describe('redlibTarget', () => {
  it('recognizes posts and subreddit listings, keeping the query', () => {
    expect(redlibTarget('https://www.reddit.com/r/t/comments/1/x/')).toEqual({
      kind: 'post',
      path: '/r/t/comments/1/x/',
      subreddit: 't',
    })
    expect(redlibTarget('https://old.reddit.com/r/t/top?t=week')).toEqual({
      kind: 'listing',
      path: '/r/t/top?t=week',
      subreddit: 't',
    })
    expect(redlibTarget('https://www.reddit.com/r/t')?.kind).toBe('listing')
    expect(redlibTarget('https://www.reddit.com/user/bob')).toBeNull()
    expect(redlibTarget('https://www.reddit.com/r/t/wiki/index')).toBeNull()
  })
})

describe('tryRedlib', () => {
  afterEach(() => vi.restoreAllMocks())
  const CANON = 'https://www.reddit.com/r/t/comments/1/x/'

  it('fetches the same path from Redlib and reports reddit.com URLs only', async () => {
    const spy = mockFetch(200, REDLIB_POST)
    const r = await tryRedlib('http://redlib:8080', CANON)
    expect(spy.mock.calls[0][0]).toBe('http://redlib:8080/r/t/comments/1/x/')
    expect(r).toMatchObject({ ok: true, method: 'reddit-redlib', title: 'Hello' })
    expect(r.finalUrl).toBe(CANON)
    expect(r.canonicalUrl).toBe(CANON)
    expect(JSON.stringify(r)).not.toContain('redlib:8080')
  })

  it('fails on non-200, on a 200 without the post landmark, and on network errors', async () => {
    mockFetch(404, '<div id="error">nope</div>')
    expect((await tryRedlib('http://redlib:8080', CANON)).ok).toBe(false)
    vi.restoreAllMocks()
    mockFetch(200, '<html><body>something else</body></html>')
    expect((await tryRedlib('http://redlib:8080', CANON)).ok).toBe(false)
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const r = await tryRedlib('http://redlib:8080', CANON)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('fetch failed')
  })
})

describe('fetchReddit with Redlib', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
  const CANON = 'https://www.reddit.com/r/t/comments/1/x/'

  it('tries Redlib first when WEBFETCH_REDLIB_URL is set', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080/')
    const spy = mockFetch(200, REDLIB_POST)
    const r = await fetchReddit(CANON)
    expect(r.method).toBe('reddit-redlib')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('http://redlib:8080/r/t/comments/1/x/')
  })

  it('falls through to the existing chain when Redlib fails', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('http://redlib:8080')) return new Response('bad gateway', { status: 502 })
      return new Response(SAMPLE_RSS, { status: 200 })
    })
    const r = await fetchReddit(CANON)
    expect(r.method).toBe('reddit-rss')
    expect(String(spy.mock.calls[0][0])).toContain('redlib:8080')
  })

  it('never contacts Redlib when WEBFETCH_REDLIB_URL is unset, matching the exact pre-Redlib call list', async () => {
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'WEBFETCH_REDLIB_URL')
    const original = process.env.WEBFETCH_REDLIB_URL
    delete process.env.WEBFETCH_REDLIB_URL
    try {
      const spy = mockFetch(200, SAMPLE_RSS)
      const r = await fetchReddit(CANON)
      expect(r.method).toBe('reddit-rss')
      // Exactly the pre-Redlib chain: the RSS URL, once, nothing else.
      expect(spy.mock.calls.map(([u]) => String(u))).toEqual([
        'https://www.reddit.com/r/t/comments/1/x.rss',
      ])
    } finally {
      if (hadEnv) process.env.WEBFETCH_REDLIB_URL = original
      else delete process.env.WEBFETCH_REDLIB_URL
    }
  })
})

describe('fetchReddit Redlib fall-through (M10)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
  const CANON = 'https://www.reddit.com/r/t/comments/1/x/'

  function mockRedlibThenRss(redlibBehavior: () => Promise<Response>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('http://redlib:8080')) return redlibBehavior()
      return new Response(SAMPLE_RSS, { status: 200 })
    })
  }

  it('falls through to the legacy chain on a Redlib timeout/AbortError', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    mockRedlibThenRss(async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    const r = await fetchReddit(CANON)
    expect(r.ok).toBe(true)
    expect(r.method).toBe('reddit-rss')
  })

  it('falls through to the legacy chain on a Redlib connection refused', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    mockRedlibThenRss(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      })
    })
    const r = await fetchReddit(CANON)
    expect(r.ok).toBe(true)
    expect(r.method).toBe('reddit-rss')
  })

  it('falls through to the legacy chain on a Redlib 404', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    mockRedlibThenRss(async () => new Response('not found', { status: 404 }))
    const r = await fetchReddit(CANON)
    expect(r.ok).toBe(true)
    expect(r.method).toBe('reddit-rss')
  })

  it('falls through to the legacy chain on a Redlib 200 without the expected landmark', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    mockRedlibThenRss(async () => new Response('<html><body>nope</body></html>', { status: 200 }))
    const r = await fetchReddit(CANON)
    expect(r.ok).toBe(true)
    expect(r.method).toBe('reddit-rss')
  })

  it('falls through to the legacy chain for a subreddit listing too', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    const LISTING_URL = 'https://www.reddit.com/r/testsub'
    const oldRedditListingPage = `<html><head><title>testsub</title></head><body><p>${'Filler listing content. '.repeat(
      20,
    )}</p></body></html>`
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('http://redlib:8080')) return new Response('bad gateway', { status: 502 })
      if (url.includes('old.reddit.com')) return new Response(oldRedditListingPage, { status: 200 })
      return new Response('', { status: 404 })
    })
    const r = await fetchReddit(LISTING_URL)
    expect(r.ok).toBe(true)
    expect(r.method).toBe('reddit-old')
    expect(r.content).toContain('Filler listing content.')
  })

  it('reports the same error whether or not Redlib is enabled, when everything fails', async () => {
    const alwaysFail = async () => new Response('server error', { status: 500 })

    vi.stubEnv('WEBFETCH_REDLIB_URL', '')
    vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysFail)
    const withoutRedlib = await fetchReddit(CANON)

    vi.restoreAllMocks()
    vi.stubEnv('WEBFETCH_REDLIB_URL', 'http://redlib:8080')
    vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysFail)
    const withRedlib = await fetchReddit(CANON)

    expect(withoutRedlib.ok).toBe(false)
    expect(withRedlib.ok).toBe(false)
    expect(withRedlib.error).toBe(withoutRedlib.error)
    expect(withRedlib.method).toBe(withoutRedlib.method)
    expect(withRedlib.method).toBe('reddit-feedfetcher')
  })
})
