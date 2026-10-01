// Parses a self-hosted Redlib instance's server-rendered HTML (a Reddit frontend)
// into webfetch's Reddit text format. Every link is rewritten back to reddit.com
// (or, for Redlib's media/proxy routes, to the real Reddit media host they
// proxy), so the internal Redlib host never appears in output.
import { parse, type HTMLElement } from 'node-html-parser'

// Redlib proxies Reddit's media hosts through routes under its own domain
// (see `format_url` in redlib-org/redlib's src/utils.rs, commit
// a4d36e954cf1bd64f209cd8868c5a29edc81b374). These are the inverse of that
// mapping, for the routes that can be reconstructed exactly or near-exactly:
//   /img/X                      -> https://i.redd.it/X
//   /preview/pre/X              -> https://preview.redd.it/X
//   /preview/external-pre/X     -> https://external-preview.redd.it/X
//   /vid/ID/QUALITY             -> https://v.redd.it/ID/DASH_QUALITY
//   /hls/ID/PLAYLIST            -> https://v.redd.it/ID/PLAYLIST
//   /emoji/A/B                  -> https://emoji.redditmedia.com/A/B
//   /thumb/a/X, /thumb/b/X      -> https://{a,b}.thumbs.redditmedia.com/X
const PROXY_ROUTES: Array<{ re: RegExp; to: (m: RegExpMatchArray) => string }> = [
  { re: /^\/img\/(.+)$/, to: (m) => `https://i.redd.it/${m[1]}` },
  { re: /^\/preview\/external-pre\/(.+)$/, to: (m) => `https://external-preview.redd.it/${m[1]}` },
  { re: /^\/preview\/pre\/(.+)$/, to: (m) => `https://preview.redd.it/${m[1]}` },
  { re: /^\/vid\/([^/]+)\/(.+)$/, to: (m) => `https://v.redd.it/${m[1]}/DASH_${m[2]}` },
  { re: /^\/hls\/([^/]+)\/(.+)$/, to: (m) => `https://v.redd.it/${m[1]}/${m[2]}` },
  { re: /^\/emoji\/([^/]+)\/(.+)$/, to: (m) => `https://emoji.redditmedia.com/${m[1]}/${m[2]}` },
  { re: /^\/thumb\/a\/(.+)$/, to: (m) => `https://a.thumbs.redditmedia.com/${m[1]}` },
  { re: /^\/thumb\/b\/(.+)$/, to: (m) => `https://b.thumbs.redditmedia.com/${m[1]}` },
]

/** Known Redlib proxy-route prefixes, for recognizing (but failing to map) a shape we don't handle. */
const PROXY_PREFIX_RE = /^\/(img|preview|vid|hls|emoji|thumb|style|static)\//

/**
 * Map a Redlib-relative href back to its real-world URL: a plain Redlib path
 * to reddit.com, a media/proxy route to the Reddit media host it proxies, a
 * protocol-relative `//host/...` to `https://host/...`, and a non-http(s)
 * scheme (`mailto:`, `tel:`, ...) through unchanged. Returns null when the
 * href looks like a Redlib proxy route but doesn't match a mappable shape —
 * the caller should drop the URL and keep just the link text rather than
 * emit a dead `reddit.com/...` link.
 */
export function toRedditUrl(href: string): string | null {
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith('//')) return `https:${href}`
  // A non-http(s) absolute scheme (mailto:, tel:, ...) passes through as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href
  for (const { re, to } of PROXY_ROUTES) {
    const m = href.match(re)
    if (m) return to(m)
  }
  if (PROXY_PREFIX_RE.test(href)) return null
  const path = href.replace(/^\/user\//, '/u/')
  return `https://www.reddit.com${path.startsWith('/') ? '' : '/'}${path}`
}

const isEl = (n: unknown): n is HTMLElement => (n as { nodeType?: number })?.nodeType === 1
const kids = (el: HTMLElement, cls: string): HTMLElement[] =>
  el.childNodes.filter(isEl).filter((c) => c.classList.contains(cls))
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * A score ("N" or "-N") rendered as "N points", or '' when Reddit hides the
 * vote count — Redlib then puts non-numeric text ("Hidden", "•") in the title
 * attribute instead of an integer.
 */
function scorePoints(score: string | null | undefined): string {
  return score && /^-?\d+$/.test(score) ? `${score} points` : ''
}

/** Escape text before handing it to `set_content`, which parses its argument as HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The verbatim text of a `<pre>` block. node-html-parser treats `pre` as a
 * raw-text element, so its decoded `.text` already has entities resolved and
 * indentation/newlines intact — but it may still contain a literal (unparsed)
 * `<code>...</code>` wrapper as plain text, which is stripped here.
 */
function preText(pre: HTMLElement): string {
  const text = pre.text
  const m = text.match(/^<code[^>]*>([\s\S]*?)<\/code>\s*$/i)
  return (m ? m[1] : text).replace(/\n+$/, '')
}

/** Markdown-ish text of a `.md` block: links as "text (url)", paragraphs on their own lines. */
function mdText(el: HTMLElement | null): string {
  if (!el) return ''
  // Pull `<pre>` blocks out before structuredText runs, so their indentation
  // and newlines survive structuredText's whitespace collapsing. Each is
  // replaced with a unique placeholder token (no whitespace of its own) and
  // spliced back in, fenced, after the rest of the text is structured.
  const codeBlocks: string[] = []
  for (const pre of el.querySelectorAll('pre')) {
    const idx = codeBlocks.push(preText(pre)) - 1
    pre.set_content(`\u0000PRE${idx}\u0000`)
  }
  // Inline `<code>` (not inside a `<pre>` — those aren't real child elements,
  // see preText above) keeps its text, wrapped in backticks.
  for (const code of el.querySelectorAll('code')) {
    code.set_content(escapeHtml(`\`${code.text}\``))
  }
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#')) continue
    const url = toRedditUrl(href)
    const text = clean(a.text)
    // No mappable URL (an unrecognized Redlib proxy route): keep just the
    // link text rather than emit a dead reddit.com/... URL.
    const label = url === null ? text : text === url ? url : `${text} (${url})`
    // The label can contain user-authored link text (e.g. "a <b> c"), which
    // set_content would otherwise parse as HTML and mangle.
    a.set_content(escapeHtml(label))
  }
  let text = el.structuredText.trim()
  codeBlocks.forEach((code, i) => {
    text = text.replace(`\u0000PRE${i}\u0000`, () => '```\n' + code + '\n```')
  })
  return text
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
  // Scoped to this comment's own header, not any nested reply's (an
  // unscoped `right.querySelector(...)` would match into `.replies`).
  const header = kids(right, 'comment_data')[0]
  const author = clean(header?.querySelector('.comment_author')?.text ?? '') || '[deleted]'
  const points = scorePoints(score)
  out.push(`${pad}[${[author, points].filter(Boolean).join(' · ')}]`)
  const body = mdText(kids(right, 'comment_body')[0]?.querySelector('.md') ?? null)
  for (const line of body.split('\n')) if (line.trim()) out.push(pad + line)
  for (const replies of kids(right, 'replies')) {
    for (const child of replies.childNodes.filter(isEl)) {
      if (child.classList.contains('comment')) {
        renderComment(child, depth + 1, out)
      } else if (child.classList.contains('deeper_replies')) {
        // Redlib truncated this reply tree ("→ More replies (N)"); point at
        // the permalink instead of silently dropping the missing replies.
        const href = child.getAttribute('href') ?? ''
        const url = toRedditUrl(href)
        if (url) out.push(`${'  '.repeat(depth + 1)}(more replies: ${url})`)
      }
    }
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
  const header = [sub, author, scorePoints(score)].filter(Boolean).join(' · ')
  const lines = [`# ${title || '(untitled)'}`, header]
  // A link post's external target: Redlib renders it as an absolute-URL anchor
  // (#post_url) on the post page, distinct from the `/preview/...` proxy paths
  // used for thumbnail images, so it's safe to surface as-is.
  const linkHref = post.querySelector('#post_url')?.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(linkHref)) lines.push(`Link: ${toRedditUrl(linkHref)}`)
  lines.push('')
  const body = mdText(post.querySelector('.post_body .md'))
  if (body) lines.push(body, '')
  // Redlib emits a separate sibling `.thread` wrapper per top-level comment chain
  // (not one `.thread` holding every top-level comment), so all of them must be scanned.
  const comments: string[] = []
  for (const thread of root.querySelectorAll('.thread')) {
    for (const c of kids(thread, 'comment')) renderComment(c, 0, comments)
  }
  if (comments.length > 0) lines.push('## Comments', '', ...comments)
  return { title, content: lines.join('\n').trim() }
}

/** A `.post` entry with a title link into `/comments/` — Redlib's listing-item landmark. */
function postCommentsLink(p: HTMLElement): HTMLElement | null {
  const h = p.querySelector('.post_title')
  const link = h
    ?.querySelectorAll('a')
    .find(
      (a) =>
        !a.classList.contains('post_flair') && /\/comments\//.test(a.getAttribute('href') ?? ''),
    )
  return link ?? null
}

export function parseRedlibListing(
  html: string,
  subreddit: string,
): { title: string; content: string } | null {
  const root = parse(html)
  // Only a `.post` with a title link into `/comments/` counts as a real
  // listing entry — guards against error/NSFW-landing/quarantine pages that
  // might otherwise contain a stray `.post`-classed element.
  const posts = root.querySelectorAll('.post').filter((p) => postCommentsLink(p))
  if (posts.length === 0) return null
  const title = `r/${subreddit}`
  const lines = [`# ${title}`, '']
  for (const p of posts) {
    const h = p.querySelector('.post_title')
    const link = postCommentsLink(p)!
    const author = clean(p.querySelector('.post_author')?.text ?? '')
    const score = p.querySelector('.post_score')?.getAttribute('title')
    const comments = p.querySelector('.post_comments')?.getAttribute('title')
    const meta = [author, scorePoints(score), comments ?? ''].filter(Boolean).join(' · ')
    lines.push(`- ${titleText(h)}${meta ? ` — ${meta}` : ''}`)
    const url = toRedditUrl(link.getAttribute('href') ?? '')
    if (url) lines.push(`  ${url}`)
  }
  // Redlib's listing footer has a "NEXT" link (`<a accesskey="N" href="?...&after=...">`)
  // when there are more posts to page through.
  const next = root.querySelector('footer a[accesskey="N"]')
  const nextHref = next?.getAttribute('href') ?? ''
  if (nextHref) {
    const query = nextHref.startsWith('?') ? nextHref : `?${nextHref.replace(/^[^?]*\??/, '')}`
    lines.push('', `Next page: https://www.reddit.com/r/${subreddit}${query}`)
  }
  return { title, content: lines.join('\n').trim() }
}
