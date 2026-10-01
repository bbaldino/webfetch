# Redlib Reddit Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a self-hosted Redlib instance the first tier of webfetch's Reddit chain — full nested comment threads and subreddit listings — with the existing chain as fallback.

**Architecture:** A pure parser module (`src/redlib.ts`) turns Redlib's server-rendered HTML into webfetch's Reddit text format, rewriting every link back to reddit.com. `fetchReddit` (`src/reddit.ts`) gains a `tryRedlib` attempt placed first when `WEBFETCH_REDLIB_URL` is set; any non-200, timeout, connection error, or page without the expected landmark falls through to the existing attempts.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, `node-html-parser` (new dependency).

**Spec:** `docs/superpowers/specs/2026-10-01-redlib-reddit-tier-design.md`

## Global Constraints

- `WEBFETCH_REDLIB_URL` unset → behavior is exactly today's (the tier is never attempted, no extra requests).
- Read `process.env.WEBFETCH_REDLIB_URL` at call time inside `fetchReddit` (not at module load), so tests can set/unset it with `vi.stubEnv`.
- Output links always point to `https://www.reddit.com/…`; the Redlib host must never appear in `content`, `canonicalUrl`, or `finalUrl`.
- `method` for this tier is `'reddit-redlib'`.
- Request timeout 15 s (`AbortSignal.timeout(15000)`).
- No real Reddit content in checked-in fixtures — synthetic HTML only.
- Add deps with `npm install <pkg>` (gets the latest), never by hand-editing `package.json`.
- Prettier config already in repo (`singleQuote`, no `semi`, `printWidth 100`); run `npx prettier --write` on changed files.
- Commit trailer, exactly: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

## Redlib markup reference (captured 2026-10-01 from a live instance)

Post page (`/r/<sub>/comments/<id>/<slug>/`):

```html
<div class="post highlighted">
  <p class="post_header">
    <a class="post_subreddit" href="/r/homeassistant">r/homeassistant</a>
    <a class="post_author " href="/user/someone">u/someone</a>
  </p>
  <h1 class="post_title">
    <a href="/r/x/search?..." class="post_flair"><span>Flair</span></a>
    The Post Title
  </h1>
  <div class="post_body">
    <div class="md">
      <p>Body with <a href="https://example.com/">a link</a>.</p>
    </div>
  </div>
  <div class="post_score" title="14">14<span class="label"> Upvotes</span></div>
</div>
<div class="thread">
  <div id="c1" class="comment">
    <div class="comment_left">
      <p class="comment_score" title="5">5</p>
      <div class="line"></div>
    </div>
    <details class="comment_right" open>
      <summary class="comment_data">
        <a class="comment_author  " href="/user/alice">u/alice</a> …
      </summary>
      <div class="comment_body ">
        <div class="md"><p>Top-level text</p></div>
      </div>
      <blockquote class="replies">
        <div id="c2" class="comment">…same shape, nested…</div>
      </blockquote>
    </details>
  </div>
</div>
```

Listing page (`/r/<sub>`, `/r/<sub>/top`, …): repeated

```html
<div class="post stickied" id="1abc">
  <p class="post_header"><a class="post_author " href="/u/bob">u/bob</a></p>
  <h2 class="post_title">
    <a href="/r/x/search?..." class="post_flair"><span>Flair</span></a>
    <a href="/r/x/comments/1abc/a_title/">A title</a>
  </h2>
  <div class="post_score" title="622">622<span class="label"> Upvotes</span></div>
  <div class="post_footer">
    <a href="/r/x/comments/1abc/a_title/" class="post_comments" title="34 comments">34 comments</a>
  </div>
</div>
```

Errors: Redlib returns Reddit's HTTP status (e.g. `404`) with an error page (`<div id="error">`).

---

### Task 1: Redlib HTML parser

**Files:**

- Create: `src/redlib.ts`
- Create: `src/redlib.test.ts`
- Modify: `package.json`, `package-lock.json` (via `npm install node-html-parser`)

**Interfaces:**

- Produces (all exported from `src/redlib.ts`):
  - `toRedditUrl(href: string): string` — relative Redlib path → `https://www.reddit.com<path>`; `/user/<x>` → `/u/<x>`; absolute URLs unchanged.
  - `parseRedlibPost(html: string): { title: string; content: string } | null` — `null` when there is no `.post.highlighted`.
  - `parseRedlibListing(html: string, subreddit: string): { title: string; content: string } | null` — `null` when there is no `.post`.

- [ ] **Step 1: Add the dependency**

Run: `npm install node-html-parser`
Expected: `package.json` `dependencies` gains `node-html-parser` (latest version).

- [ ] **Step 2: Write the failing tests** (`src/redlib.test.ts`)

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/redlib.test.ts`
Expected: FAIL — `Cannot find module './redlib.js'`.

- [ ] **Step 4: Implement** (`src/redlib.ts`)

```ts
// Parses a self-hosted Redlib instance's server-rendered HTML (a Reddit frontend)
// into webfetch's Reddit text format. Every link is rewritten back to reddit.com,
// so the internal Redlib host never appears in output.
import { parse, type HTMLElement } from 'node-html-parser'

export function toRedditUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href
  const path = href.replace(/^\/user\//, '/u/')
  return `https://www.reddit.com${path.startsWith('/') ? '' : '/'}${path}`
}

const isEl = (n: unknown): n is HTMLElement => (n as { nodeType?: number })?.nodeType === 1
const kids = (el: HTMLElement, cls: string): HTMLElement[] =>
  el.childNodes.filter(isEl).filter((c) => c.classList.contains(cls))
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Markdown-ish text of a `.md` block: links as "text (url)", paragraphs on their own lines. */
function mdText(el: HTMLElement | null): string {
  if (!el) return ''
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#')) continue
    const url = toRedditUrl(href)
    const text = clean(a.text)
    const label = text === url || text === href ? url : `${text} (${url})`
    a.set_content(label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  }
  return el.structuredText.trim()
}

/** Title text of a post, without its flair link. */
function titleText(h: HTMLElement | null): string {
  if (!h) return ''
  const flair = h.querySelector('.post_flair')
  return clean(h.text.replace(flair?.text ?? '', ''))
}

function renderComment(c: HTMLElement, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth)
  const score = kids(c, 'comment_left')[0]?.querySelector('.comment_score')?.getAttribute('title')
  const right = kids(c, 'comment_right')[0]
  if (!right) return
  const author = clean(right.querySelector('.comment_author')?.text ?? '') || '[deleted]'
  out.push(`${pad}[${author}${score ? ` · ${score} points` : ''}]`)
  const body = mdText(kids(right, 'comment_body')[0]?.querySelector('.md') ?? null)
  for (const line of body.split('\n')) if (line.trim()) out.push(pad + line)
  for (const replies of kids(right, 'replies')) {
    for (const child of kids(replies, 'comment')) renderComment(child, depth + 1, out)
  }
}

export function parseRedlibPost(html: string): { title: string; content: string } | null {
  const root = parse(html)
  const post = root.querySelector('.post.highlighted')
  if (!post) return null
  const title = titleText(post.querySelector('.post_title'))
  const sub = clean(post.querySelector('.post_subreddit')?.text ?? '')
  const author = clean(post.querySelector('.post_author')?.text ?? '')
  const score = post.querySelector('.post_score')?.getAttribute('title')
  const header = [sub, author, score ? `${score} points` : ''].filter(Boolean).join(' · ')
  const lines = [`# ${title || '(untitled)'}`, header, '']
  const body = mdText(post.querySelector('.post_body .md'))
  if (body) lines.push(body, '')
  const thread = root.querySelector('.thread')
  const comments: string[] = []
  if (thread) for (const c of kids(thread, 'comment')) renderComment(c, 0, comments)
  if (comments.length > 0) lines.push('## Comments', '', ...comments)
  return { title, content: lines.join('\n').trim() }
}

export function parseRedlibListing(
  html: string,
  subreddit: string,
): { title: string; content: string } | null {
  const posts = parse(html).querySelectorAll('.post')
  if (posts.length === 0) return null
  const title = `r/${subreddit}`
  const lines = [`# ${title}`, '']
  for (const p of posts) {
    const h = p.querySelector('.post_title')
    const link = h?.querySelectorAll('a').find((a) => !a.classList.contains('post_flair'))
    const author = clean(p.querySelector('.post_author')?.text ?? '')
    const score = p.querySelector('.post_score')?.getAttribute('title')
    const comments = p.querySelector('.post_comments')?.getAttribute('title')
    const meta = [author, score ? `${score} points` : '', comments ?? '']
      .filter(Boolean)
      .join(' · ')
    lines.push(`- ${titleText(h)}${meta ? ` — ${meta}` : ''}`)
    if (link?.getAttribute('href')) lines.push(`  ${toRedditUrl(link.getAttribute('href')!)}`)
  }
  return { title, content: lines.join('\n').trim() }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/redlib.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean. If a node-html-parser API detail differs (e.g. `structuredText` spacing, `set_content` escaping, entity decoding in `.text`), fix the implementation — not the expected strings — unless the expectation is genuinely wrong; note any change in your report.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/redlib.ts src/redlib.test.ts
git add src/redlib.ts src/redlib.test.ts package.json package-lock.json
git commit -m "$(printf 'feat: parse Redlib post and listing pages into Reddit text\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `tryRedlib` tier in `fetchReddit`, docs, live check

**Files:**

- Modify: `src/reddit.ts` (add `tryRedlib`, `redlibTarget`; wire into `fetchReddit`)
- Modify: `src/reddit.test.ts` (tier tests)
- Modify: `src/reddit.integration.test.ts` (Redlib case)
- Modify: `README.md` (env var + pin note)

**Interfaces:**

- Consumes: `parseRedlibPost(html)`, `parseRedlibListing(html, subreddit)`, `toRedditUrl` from `./redlib.js` (Task 1).
- Produces:
  - `export function redlibTarget(canonical: string): { kind: 'post' | 'listing'; path: string; subreddit: string } | null` — `path` is pathname + search; `null` for anything that isn't a post or a subreddit listing (`/r/<sub>`, `/r/<sub>/`, `/r/<sub>/(hot|new|top|rising|controversial)`).
  - `export async function tryRedlib(base: string, canonical: string): Promise<RedditResult>`

- [ ] **Step 1: Write the failing tests** — append to `src/reddit.test.ts`

Extend the import from `./reddit.js` with `fetchReddit, tryRedlib, redlibTarget`. The file already has a `mockFetch(status, body)` helper; use `vi.spyOn(globalThis, 'fetch')` directly where per-URL behavior is needed.

```ts
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

  it('never contacts Redlib when WEBFETCH_REDLIB_URL is unset', async () => {
    vi.stubEnv('WEBFETCH_REDLIB_URL', '')
    const spy = mockFetch(200, SAMPLE_RSS)
    await fetchReddit(CANON)
    expect(spy.mock.calls.every(([u]) => !String(u).includes('redlib'))).toBe(true)
  })
})
```

If the existing `mockFetch` helper doesn't return the spy, change it to `return vi.spyOn(...)…` (keep its existing behavior otherwise).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/reddit.test.ts`
Expected: FAIL — `tryRedlib`/`redlibTarget` not exported.

- [ ] **Step 3: Implement** in `src/reddit.ts`

Add the import:

```ts
import { parseRedlibListing, parseRedlibPost } from './redlib.js'
```

Add (near the other `try*` functions):

```ts
const LISTING_RE = /^\/r\/([^/]+)(?:\/(?:hot|new|top|rising|controversial))?\/?$/
const POST_RE = /^\/r\/([^/]+)\/comments\//

/** What a reddit URL maps to on Redlib, or null if this tier doesn't handle it. */
export function redlibTarget(
  canonical: string,
): { kind: 'post' | 'listing'; path: string; subreddit: string } | null {
  let u: URL
  try {
    u = new URL(canonical)
  } catch {
    return null
  }
  const post = u.pathname.match(POST_RE)
  if (post) return { kind: 'post', path: u.pathname, subreddit: post[1] }
  const listing = u.pathname.match(LISTING_RE)
  if (listing) return { kind: 'listing', path: u.pathname + u.search, subreddit: listing[1] }
  return null
}

/**
 * Fetch via a self-hosted Redlib instance (WEBFETCH_REDLIB_URL): full nested comment
 * threads and subreddit listings. Redlib passes Reddit's status through and 5xxs when
 * Reddit blocks it, so anything but a 200 page with the expected landmark is a failure
 * and the chain falls through. Output and URLs reference reddit.com, never Redlib.
 */
export async function tryRedlib(base: string, canonical: string): Promise<RedditResult> {
  const target = redlibTarget(canonical)
  const redditUrl = toRedditCanonical(canonical, target)
  const fail = (error: string): RedditResult => ({
    ok: false,
    content: '',
    bytes: 0,
    canonicalUrl: redditUrl,
    finalUrl: redditUrl,
    method: 'reddit-redlib',
    error,
  })
  if (!target) return fail('not a post or subreddit listing')
  let status: number
  let html: string
  try {
    const response = await fetch(base.replace(/\/+$/, '') + target.path, {
      signal: AbortSignal.timeout(15000),
    })
    status = response.status
    html = await response.text()
  } catch (err) {
    return fail(`Redlib request failed: ${(err as Error).message}`)
  }
  if (status !== 200) return fail(`Redlib HTTP ${status}`)
  const parsed =
    target.kind === 'post' ? parseRedlibPost(html) : parseRedlibListing(html, target.subreddit)
  if (!parsed) return fail(`Redlib page had no ${target.kind}`)
  return {
    ok: true,
    content: parsed.content,
    bytes: parsed.content.length,
    canonicalUrl: redditUrl,
    finalUrl: redditUrl,
    method: 'reddit-redlib',
    title: parsed.title,
  }
}

/** The www.reddit.com form of a URL (keeping the path + query Redlib was asked for). */
function toRedditCanonical(url: string, target: { path: string } | null): string {
  try {
    const u = new URL(url)
    return `https://www.reddit.com${target?.path ?? u.pathname + u.search}`
  } catch {
    return url
  }
}
```

In `fetchReddit`, put the Redlib attempt first, reading the env at call time:

```ts
  const attempts: Array<() => Promise<RedditResult>> = []
  const redlib = process.env.WEBFETCH_REDLIB_URL
  if (redlib) attempts.push(() => tryRedlib(redlib, canonical)) // full threads + listings
  if (isPost) {
```

(Leave the rest of the attempt list unchanged.) Update the `fetchReddit` doc comment and the module header comment to mention Redlib as the first tier when configured.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/reddit.test.ts && npm run typecheck && npm run lint && npm test`
Expected: PASS, clean, full suite green.

- [ ] **Step 5: Integration test + README**

In `src/reddit.integration.test.ts`, add a second `describe.skipIf(process.env.REDDIT_INTEGRATION !== '1' || !process.env.WEBFETCH_REDLIB_URL)` block that runs `fetchReddit` over the same corpus and additionally asserts `r.method === 'reddit-redlib'` and `r.content` contains `'## Comments'` for post URLs, plus one subreddit listing (`https://www.reddit.com/r/homeassistant`) asserting `method === 'reddit-redlib'` and content starting with `'# r/homeassistant'`.

README: in the Reddit section, document `WEBFETCH_REDLIB_URL` — what it is (a self-hosted Redlib, first tier: full nested threads and subreddit listings), that unset means today's chain, that failures fall through, that the official quay.io image is stale so build from a pinned commit (`Dockerfile.ubuntu`), and that when Reddit breaks it the fix is bumping the pin. Keep it LAN-internal (no published port).

- [ ] **Step 6: Live check (if a Redlib is reachable)**

If `docker` is available on this machine: `docker run -d --rm --name redlib-check -p 127.0.0.1:8088:8080 redlib-main` (the image `redlib-main` was built locally during the spike; if missing, skip), wait for `curl -s http://127.0.0.1:8088/info` to answer, then run
`REDDIT_INTEGRATION=1 WEBFETCH_REDLIB_URL=http://127.0.0.1:8088 npx vitest run src/reddit.integration.test.ts`
and report the result honestly; `docker stop redlib-check` afterwards. Never weaken assertions to pass.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/reddit.ts src/reddit.test.ts src/reddit.integration.test.ts README.md
git add src/reddit.ts src/reddit.test.ts src/reddit.integration.test.ts README.md
git commit -m "$(printf 'feat: Redlib as the first Reddit tier when WEBFETCH_REDLIB_URL is set\n\nFull nested comment threads and subreddit listings from a self-hosted Redlib;\nany failure falls through to the existing RSS/JSON/scrape chain.\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:** config/unset behavior → Global Constraints + Task 2 test "never contacts". Posts + listings with query kept → `redlibTarget`. Fall-through on non-200/timeout/refused/no landmark → `tryRedlib` + tests. Real HTML parser → Task 1 (`node-html-parser`). Output shapes (header line, nested two-space indent, listing format), reddit.com link rewriting, no host leak, `method`, `finalUrl` → Task 1 + Task 2 tests. 50 000-char cap → unchanged existing truncation in `tools.ts`. Synthetic fixtures → Task 1. Gated integration → Task 2 Step 5. README → Task 2 Step 5. Rollout (deploy, env, verify) is operational, done after release.

**Placeholder scan:** none.

**Type consistency:** `parseRedlibPost`/`parseRedlibListing` return `{ title, content } | null` in both tasks; `redlibTarget` shape is the same in tests and implementation; `RedditResult` fields match the existing interface.
