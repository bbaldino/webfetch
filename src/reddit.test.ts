import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseRedditRss,
  looksBlocked,
  tryRssFeed,
  tryFeedFetcher,
  extractRedditPageText,
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

function mockFetch(status: number, body: string): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
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
