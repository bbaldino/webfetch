import { describe, it, expect } from 'vitest'
import { parseRedlibListing, parseRedlibPost, toRedditUrl } from './redlib.js'

const comment = (id: string, author: string, score: string, body: string, replies = '') => `
<div id="${id}" class="comment">
  <div class="comment_left"><p class="comment_score" title="${score}">${score}</p><div class="line"></div></div>
  <details class="comment_right" open>
    <summary class="comment_data"><a class="comment_author  " href="/user/${author}">u/${author}</a>
      <a href="/r/t/comments/1/x/${id}/?context=3#${id}" class="created" title="Sep 29 2026">1d ago</a></summary>
    <div class="comment_body "><div class="md">${body}</div></div>
    ${replies ? `<blockquote class="replies">${replies}</blockquote>` : ''}
  </details>
</div>`

const POST = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/testsub">r/testsub</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">
    <a href="/r/testsub/search?q=flair" class="post_flair"><span>Show &amp; Tell</span></a>
    My &amp; Great Post
  </h1>
  <div class="post_body"><div class="md"><p>See <a href="https://example.com/x">the docs</a> and <a href="/r/other">/r/other</a>.</p><p>Second para.</p></div></div>
  <div class="post_score" title="14">14<span class="label"> Upvotes</span></div>
</div>
<div class="thread">
${comment('c1', 'alice', '11', '<p>Top level</p>', comment('c2', 'bob', '2', '<p>A reply</p>', comment('c3', 'carol', '1', '<p>Deeper</p>')))}
${comment('c4', 'dave', '-3', '<p>Second top</p>')}
</div>
</main></body></html>`

const LISTING = `<html><body><main>
<div class="post stickied" id="1a">
  <p class="post_header"><a class="post_author " href="/u/bob">u/bob</a></p>
  <h2 class="post_title">
    <a href="/r/testsub/search?q=flair" class="post_flair"><span>Blog</span></a>
    <a href="/r/testsub/comments/1a/first_post/">First &amp; post</a>
  </h2>
  <div class="post_score" title="622">622<span class="label"> Upvotes</span></div>
  <div class="post_footer"><a href="/r/testsub/comments/1a/first_post/" class="post_comments" title="34 comments">34 comments</a></div>
</div>
<hr class="sep" />
<div class="post" id="1b">
  <p class="post_header"><a class="post_author " href="/u/eve">u/eve</a></p>
  <h2 class="post_title"><a href="/r/testsub/comments/1b/second/">Second</a></h2>
  <div class="post_score" title="5">5<span class="label"> Upvotes</span></div>
  <div class="post_footer"><a href="/r/testsub/comments/1b/second/" class="post_comments" title="0 comments">0 comments</a></div>
</div>
</main></body></html>`

const ERROR_PAGE = `<html><body><div id="error"><h1>Reddit error 404 "null": "Not Found"</h1></div></body></html>`

describe('toRedditUrl', () => {
  it('maps Redlib-relative paths back to reddit.com', () => {
    expect(toRedditUrl('/r/x/comments/1/y/')).toBe('https://www.reddit.com/r/x/comments/1/y/')
    expect(toRedditUrl('/user/alice')).toBe('https://www.reddit.com/u/alice')
    expect(toRedditUrl('https://example.com/a')).toBe('https://example.com/a')
  })

  // Redlib proxies Reddit's media hosts through its own routes (see
  // format_url in redlib-org/redlib src/utils.rs). Those routes must map back
  // to the real media host, never to a dead reddit.com/img/... URL.
  it('maps Redlib media/proxy routes back to their real Reddit media host', () => {
    expect(toRedditUrl('/img/abc123.jpg')).toBe('https://i.redd.it/abc123.jpg')
    expect(toRedditUrl('/preview/pre/xyz.png?width=100&auto=webp')).toBe(
      'https://preview.redd.it/xyz.png?width=100&auto=webp',
    )
    expect(toRedditUrl('/preview/external-pre/xyz.jpg?auto=webp&s=bar')).toBe(
      'https://external-preview.redd.it/xyz.jpg?auto=webp&s=bar',
    )
    expect(toRedditUrl('/vid/foo/360.mp4')).toBe('https://v.redd.it/foo/DASH_360.mp4')
    expect(toRedditUrl('/hls/foo/HLSPlaylist.m3u8?a=bar')).toBe(
      'https://v.redd.it/foo/HLSPlaylist.m3u8?a=bar',
    )
    expect(toRedditUrl('/emoji/a2x/b.png')).toBe('https://emoji.redditmedia.com/a2x/b.png')
    expect(toRedditUrl('/thumb/a/XYZ.jpg')).toBe('https://a.thumbs.redditmedia.com/XYZ.jpg')
    expect(toRedditUrl('/thumb/b/XYZ.jpg')).toBe('https://b.thumbs.redditmedia.com/XYZ.jpg')
  })

  it('returns null for a recognized proxy prefix that does not match a mappable shape', () => {
    // Starts with a known Redlib proxy prefix but doesn't fit any mappable
    // pattern (e.g. a /preview/ route that is neither /pre/ nor /external-pre/).
    expect(toRedditUrl('/preview/thumbnail/xyz.png')).toBeNull()
    expect(toRedditUrl('/vid/missing-quality-segment')).toBeNull()
  })

  it('still maps an ordinary Redlib-relative path that happens to share no proxy prefix', () => {
    expect(toRedditUrl('/r/testsub/comments/1/x/')).toBe(
      'https://www.reddit.com/r/testsub/comments/1/x/',
    )
  })

  it('turns a protocol-relative href into an https:// URL', () => {
    expect(toRedditUrl('//cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
  })

  it('passes mailto: and other non-http schemes through unchanged', () => {
    expect(toRedditUrl('mailto:x@y.z')).toBe('mailto:x@y.z')
    expect(toRedditUrl('tel:+15551234567')).toBe('tel:+15551234567')
  })
})

describe('parseRedlibPost', () => {
  const r = parseRedlibPost(POST)!

  it('extracts title (without flair), header and body with links as reddit/absolute URLs', () => {
    expect(r.title).toBe('My & Great Post')
    expect(r.content).toMatch(/^# My & Great Post\nr\/testsub · u\/op · 14 points\n/)
    expect(r.content).toContain('the docs (https://example.com/x)')
    expect(r.content).toContain('/r/other (https://www.reddit.com/r/other)')
    expect(r.content).toContain('Second para.')
    expect(r.content).not.toContain('Show & Tell')
  })

  it('renders the comment tree nested, in order, with scores', () => {
    const comments = r.content.slice(r.content.indexOf('## Comments'))
    expect(comments).toBe(
      [
        '## Comments',
        '',
        '[u/alice · 11 points]',
        'Top level',
        '  [u/bob · 2 points]',
        '  A reply',
        '    [u/carol · 1 points]',
        '    Deeper',
        '[u/dave · -3 points]',
        'Second top',
      ].join('\n'),
    )
  })

  it('never leaks a Redlib-relative link', () => {
    expect(r.content).not.toMatch(/\(\/[a-z]/)
  })

  it('returns null for an error page or a listing', () => {
    expect(parseRedlibPost(ERROR_PAGE)).toBeNull()
    expect(parseRedlibPost(LISTING)).toBeNull()
  })
})

describe('parseRedlibPost with multiple top-level threads', () => {
  // Real Redlib pages wrap each top-level comment chain in its own sibling
  // `.thread` div, rather than one `.thread` holding every top-level comment
  // (observed against a live instance's post HTML during the spike).
  const MULTI_THREAD = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/testsub">r/testsub</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">My Post</h1>
  <div class="post_body"><div class="md"><p>Body</p></div></div>
  <div class="post_score" title="1">1</div>
</div>
<div class="thread">
${comment('c1', 'alice', '11', '<p>First thread</p>')}
</div><div class="thread">
${comment('c2', 'bob', '2', '<p>Second thread</p>')}
</div>
</main></body></html>`

  it('collects comments from every sibling .thread wrapper, not just the first', () => {
    const r = parseRedlibPost(MULTI_THREAD)!
    const comments = r.content.slice(r.content.indexOf('## Comments'))
    expect(comments).toBe(
      [
        '## Comments',
        '',
        '[u/alice · 11 points]',
        'First thread',
        '[u/bob · 2 points]',
        'Second thread',
      ].join('\n'),
    )
  })
})

describe('hidden scores', () => {
  // Reddit hides vote counts on some posts/comments; Redlib then renders the
  // title attribute as "Hidden" (or "•") instead of a number. Only a real
  // integer (optionally negative) should ever become "N points".
  const HIDDEN_POST = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/testsub">r/testsub</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">Hidden score post</h1>
  <div class="post_body"><div class="md"><p>Body</p></div></div>
  <div class="post_score" title="Hidden">&bull;<span class="label"> Upvotes</span></div>
</div>
<div class="thread">
${comment('c1', 'alice', '•', '<p>Comment with hidden score</p>')}
</div>
</main></body></html>`

  it('omits the score from the post header and a comment when it is non-numeric', () => {
    const r = parseRedlibPost(HIDDEN_POST)!
    expect(r.content).toMatch(/^# Hidden score post\nr\/testsub · u\/op\n/)
    expect(r.content).not.toContain('Hidden points')
    expect(r.content).not.toContain('• points')
    expect(r.content).toContain('[u/alice]')
    expect(r.content).not.toContain('[u/alice ·')
  })

  it('omits the score from a listing entry when it is non-numeric', () => {
    const HIDDEN_LISTING = `<html><body><main>
<div class="post" id="1a">
  <p class="post_header"><a class="post_author " href="/u/bob">u/bob</a></p>
  <h2 class="post_title"><a href="/r/testsub/comments/1a/x/">A post</a></h2>
  <div class="post_score" title="Hidden">&bull;<span class="label"> Upvotes</span></div>
  <div class="post_footer"><a href="/r/testsub/comments/1a/x/" class="post_comments" title="4 comments">4 comments</a></div>
</div>
</main></body></html>`
    const r = parseRedlibListing(HIDDEN_LISTING, 'testsub')!
    expect(r.content).toContain('- A post — u/bob · 4 comments')
    expect(r.content).not.toContain('Hidden points')
  })
})

describe('escaped link text', () => {
  it('keeps link text containing "<3" (and a literal tag-shaped string) intact', () => {
    const html = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/testsub">r/testsub</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">Link text post</h1>
  <div class="post_body"><div class="md"><p>I <a href="https://example.com/heart">&lt;3</a> this and <a href="https://example.com/b">a &lt;b&gt; c</a> too.</p></div></div>
  <div class="post_score" title="1">1</div>
</div>
<div class="thread"></div>
</main></body></html>`
    const r = parseRedlibPost(html)!
    expect(r.content).toContain('<3 (https://example.com/heart)')
    expect(r.content).toContain('a <b> c (https://example.com/b)')
  })
})

describe('media and proxy links in a comment/post body', () => {
  const bodyPost = (md: string) => `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/testsub">r/testsub</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">Media links post</h1>
  <div class="post_body"><div class="md">${md}</div></div>
  <div class="post_score" title="1">1</div>
</div>
<div class="thread"></div>
</main></body></html>`

  it('maps Redlib media/proxy hrefs to their real reddit media host', () => {
    const html = bodyPost(
      '<p>' +
        '<a href="/img/abc.jpg">pic</a> ' +
        '<a href="/preview/pre/xyz.png?width=1">prev</a> ' +
        '<a href="/preview/external-pre/ext.jpg">ext</a> ' +
        '<a href="/vid/foo/360.mp4">vid</a>' +
        '</p>',
    )
    const r = parseRedlibPost(html)!
    expect(r.content).toContain('pic (https://i.redd.it/abc.jpg)')
    expect(r.content).toContain('prev (https://preview.redd.it/xyz.png?width=1)')
    expect(r.content).toContain('ext (https://external-preview.redd.it/ext.jpg)')
    expect(r.content).toContain('vid (https://v.redd.it/foo/DASH_360.mp4)')
    // Never a dead reddit.com/img/... or reddit.com/preview/... URL.
    expect(r.content).not.toMatch(/reddit\.com\/(img|preview|vid)\//)
  })

  it('turns //host hrefs into https:// and passes mailto: through unchanged', () => {
    const html = bodyPost(
      '<p><a href="//cdn.example.com/a.png">cdn link</a> ' +
        '<a href="mailto:x@y.z">email me</a></p>',
    )
    const r = parseRedlibPost(html)!
    expect(r.content).toContain('cdn link (https://cdn.example.com/a.png)')
    expect(r.content).toContain('email me (mailto:x@y.z)')
  })

  it('drops an unmappable proxy link, keeping only its link text', () => {
    const html = bodyPost('<p>see <a href="/preview/thumbnail/xyz.png">this image</a> here</p>')
    const r = parseRedlibPost(html)!
    expect(r.content).toContain('see this image here')
    expect(r.content).not.toContain('/preview/thumbnail')
    expect(r.content).not.toContain('(https://www.reddit.com/preview')
  })
})

describe('code blocks', () => {
  it('renders <pre><code> verbatim, preserving indentation and newlines', () => {
    const yaml =
      'automation:\n' +
      '  - alias: Turn on light\n' +
      '    trigger:\n' +
      '      - platform: state\n' +
      '        entity_id: binary_sensor.motion\n' +
      '        to: "on"\n' +
      '    action:\n' +
      '      - service: light.turn_on'
    const escaped = yaml
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
    const html = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/homeassistant">r/homeassistant</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">YAML post</h1>
  <div class="post_body"><div class="md"><p>Here's my config:</p><pre><code>${escaped}
</code></pre><p>Hope it helps, and don't forget <code>service: light.turn_on</code> inline too.</p></div></div>
  <div class="post_score" title="1">1</div>
</div>
<div class="thread"></div>
</main></body></html>`
    const r = parseRedlibPost(html)!
    expect(r.content).toContain(yaml)
    expect(r.content).not.toContain('<code>')
    expect(r.content).not.toContain('</code>')
    expect(r.content).not.toContain('<pre>')
    // Inline code keeps backticks.
    expect(r.content).toContain('`service: light.turn_on`')
  })
})

describe('link posts', () => {
  it('emits a Link: line under the header for a post pointing at an external URL', () => {
    const html = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/technology">r/technology</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">An article</h1>
  <!-- POST MEDIA -->
  <!-- post_type: link -->
  <a id="post_url" href="https://example.com/article" rel="nofollow">https://example.com/article</a>
  <div class="post_body"></div>
  <div class="post_score" title="10">10</div>
</div>
<div class="thread"></div>
</main></body></html>`
    const r = parseRedlibPost(html)!
    expect(r.content).toBe(
      '# An article\nr/technology · u/op · 10 points\nLink: https://example.com/article',
    )
  })

  it('does not emit a Link: line for a self post', () => {
    const r = parseRedlibPost(POST)!
    expect(r.content).not.toContain('Link:')
  })
})

describe('parseRedlibListing', () => {
  it('lists posts with author, score, comment count and reddit.com links', () => {
    const r = parseRedlibListing(LISTING, 'testsub')!
    expect(r.title).toBe('r/testsub')
    expect(r.content).toBe(
      [
        '# r/testsub',
        '',
        '- First & post — u/bob · 622 points · 34 comments',
        '  https://www.reddit.com/r/testsub/comments/1a/first_post/',
        '- Second — u/eve · 5 points · 0 comments',
        '  https://www.reddit.com/r/testsub/comments/1b/second/',
      ].join('\n'),
    )
  })

  it('returns null when there are no posts', () => {
    expect(parseRedlibListing(ERROR_PAGE, 'testsub')).toBeNull()
  })

  it('requires at least one .post with a title link to /comments/, and skips entries without one', () => {
    // Only `.post` on the page has no title link into /comments/ at all
    // (e.g. a malformed or ad-like entry) — the page must not be treated as
    // a valid listing just because a `.post` div exists.
    const NO_TITLE_LINK = `<html><body><main>
<div class="post" id="1a">
  <p class="post_header"><a class="post_author " href="/u/bob">u/bob</a></p>
  <h2 class="post_title">No link here</h2>
  <div class="post_score" title="1">1</div>
</div>
</main></body></html>`
    expect(parseRedlibListing(NO_TITLE_LINK, 'testsub')).toBeNull()

    // A mix: one post with a real title link, one without — the valid
    // listing is kept, but the link-less entry is skipped entirely.
    const MIXED = `<html><body><main>
<div class="post" id="1a">
  <p class="post_header"><a class="post_author " href="/u/bob">u/bob</a></p>
  <h2 class="post_title">No link here</h2>
  <div class="post_score" title="1">1</div>
</div>
<div class="post" id="1b">
  <p class="post_header"><a class="post_author " href="/u/eve">u/eve</a></p>
  <h2 class="post_title"><a href="/r/testsub/comments/1b/second/">Second</a></h2>
  <div class="post_score" title="5">5</div>
  <div class="post_footer"><a href="/r/testsub/comments/1b/second/" class="post_comments" title="0 comments">0 comments</a></div>
</div>
</main></body></html>`
    const r = parseRedlibListing(MIXED, 'testsub')!
    expect(r.content).not.toContain('No link here')
    expect(r.content).toContain('- Second — u/eve · 5 points · 0 comments')
  })

  it('appends a Next page line, keeping the query, when Redlib has a NEXT link', () => {
    const WITH_NEXT = `<html><body><main>
<div id="posts">
<div class="post" id="1a">
  <p class="post_header"><a class="post_author " href="/u/bob">u/bob</a></p>
  <h2 class="post_title"><a href="/r/testsub/comments/1a/first/">First</a></h2>
  <div class="post_score" title="1">1</div>
</div>
</div>
<footer>
  <a href="?sort=hot&amp;t=day&amp;after=t3_abc123" accesskey="N">NEXT</a>
</footer>
</main></body></html>`
    const r = parseRedlibListing(WITH_NEXT, 'testsub')!
    expect(r.content).toContain(
      'Next page: https://www.reddit.com/r/testsub?sort=hot&t=day&after=t3_abc123',
    )
  })

  it('emits no Next page line when there is no NEXT link', () => {
    const r = parseRedlibListing(LISTING, 'testsub')!
    expect(r.content).not.toContain('Next page:')
  })
})

describe('comment author scoping (M1)', () => {
  it('does not fall through to a nested reply author when the comment itself has none', () => {
    // A comment whose own `.comment_data` header has no `.comment_author`
    // element at all, with a nested reply that does — the parser must not
    // mistakenly pick up the reply's author via an unscoped descendant query.
    const html = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/testsub">r/testsub</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">Post</h1>
  <div class="post_body"><div class="md"><p>Body</p></div></div>
  <div class="post_score" title="1">1</div>
</div>
<div class="thread">
<div id="c1" class="comment">
  <div class="comment_left"><p class="comment_score" title="1">1</p><div class="line"></div></div>
  <details class="comment_right" open>
    <summary class="comment_data"><span>(no author element here)</span></summary>
    <div class="comment_body"><div class="md"><p>[removed]</p></div></div>
    <blockquote class="replies">
      <div id="c2" class="comment">
        <div class="comment_left"><p class="comment_score" title="5">5</p><div class="line"></div></div>
        <details class="comment_right" open>
          <summary class="comment_data"><a class="comment_author" href="/user/child">u/child</a></summary>
          <div class="comment_body"><div class="md"><p>A reply</p></div></div>
        </details>
      </div>
    </blockquote>
  </details>
</div>
</div>
</main></body></html>`
    const r = parseRedlibPost(html)!
    expect(r.content).toContain('[[deleted] · 1 points]\n[removed]')
    expect(r.content).not.toContain('[u/child]\n[removed]')
    expect(r.content).toContain('  [u/child · 5 points]')
  })
})

describe('truncated reply trees (M2)', () => {
  it('emits an indented "(more replies: ...)" line where Redlib truncated a tree', () => {
    const html = `<html><body><main>
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/testsub">r/testsub</a>
    <a class="post_author " href="/user/op">u/op</a>
  </p>
  <h1 class="post_title">Post</h1>
  <div class="post_body"><div class="md"><p>Body</p></div></div>
  <div class="post_score" title="1">1</div>
</div>
<div class="thread">
<div id="c1" class="comment">
  <div class="comment_left"><p class="comment_score" title="1">1</p><div class="line"></div></div>
  <details class="comment_right" open>
    <summary class="comment_data"><a class="comment_author" href="/user/alice">u/alice</a></summary>
    <div class="comment_body"><div class="md"><p>Top level</p></div></div>
    <blockquote class="replies">
      <a class="deeper_replies" href="/r/testsub/comments/1/x/c1">&rarr; More replies (5)</a>
    </blockquote>
  </details>
</div>
</div>
</main></body></html>`
    const r = parseRedlibPost(html)!
    expect(r.content).toContain(
      '  (more replies: https://www.reddit.com/r/testsub/comments/1/x/c1)',
    )
  })
})
