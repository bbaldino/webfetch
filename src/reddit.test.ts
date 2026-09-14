import { describe, it, expect } from 'vitest'
import { parseRedditRss, looksBlocked } from './reddit.js'

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
