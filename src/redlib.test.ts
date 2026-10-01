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
})
