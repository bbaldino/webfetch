/**
 * Reddit-aware fetching. Reddit blocks default fetch UAs but accepts:
 *   1. <canonical>.json + Chrome UA → structured JSON with post + comments
 *   2. old.reddit.com/<path> + Chrome UA → SSR HTML fallback
 *   3. <canonical> + FeedFetcher-Google UA → full SSR shreddit HTML (fragile)
 *
 * Share links (/s/<id>) must be redirect-resolved to canonical
 * (/r/<sub>/comments/<id>/<slug>/) before any of these tricks work.
 */

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.109 Safari/537.36'
const FEEDFETCHER_UA = 'FeedFetcher-Google; (+http://www.google.com/feedfetcher.html)'

export interface RedditResult {
  ok: boolean
  content: string
  bytes: number
  /** The canonical reddit.com URL (after share-link resolution, no query/hash). */
  canonicalUrl: string
  /** The actual endpoint hit (e.g. .../comments/.../foo.json). */
  finalUrl: string
  method: string
  /** Post title, when available (parsed from JSON or Reddit HTML). */
  title?: string
  error?: string
}

const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
])

export function isRedditUrl(url: string): boolean {
  try {
    return REDDIT_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Follow redirects on share links (/s/<id>) to discover the canonical
 * /r/<sub>/comments/<id>/<slug>/ URL. For canonical URLs, returns input.
 */
async function resolveCanonicalUrl(url: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!/^\/r\/[^/]+\/s\//.test(parsed.pathname)) return url
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': CHROME_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    return response.url || url
  } catch {
    return url
  }
}

/**
 * Strip query/fragment, normalize to www.reddit.com/r/<sub>/comments/<id>/<slug>/
 */
function toCanonicalPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!/^\/r\/[^/]+\/comments\//.test(parsed.pathname)) return null
    parsed.host = 'www.reddit.com'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

interface RedditPost {
  title?: string
  author?: string
  subreddit?: string
  score?: number
  num_comments?: number
  selftext?: string
  url?: string
  permalink?: string
  is_self?: boolean
  link_flair_text?: string
  created_utc?: number
}

interface RedditComment {
  author?: string
  body?: string
  score?: number
  replies?: { data?: { children?: Array<{ kind: string; data: RedditComment }> } } | string
}

const MAX_TOP_COMMENTS = 20
const MAX_DEPTH = 2
const MAX_OUTPUT_BYTES = 30000

function formatRedditJson(data: unknown): string {
  if (!Array.isArray(data) || data.length < 1) {
    return 'Reddit returned unexpected JSON shape'
  }
  const postListing = data[0] as { data?: { children?: Array<{ data: RedditPost }> } }
  const post = postListing?.data?.children?.[0]?.data
  if (!post) return 'Reddit returned no post data'

  const lines: string[] = []
  lines.push(`# ${post.title ?? '(untitled)'}`)
  const meta: string[] = []
  if (post.author) meta.push(`u/${post.author}`)
  if (post.subreddit) meta.push(`r/${post.subreddit}`)
  if (typeof post.score === 'number') meta.push(`${post.score} points`)
  if (typeof post.num_comments === 'number') meta.push(`${post.num_comments} comments`)
  if (post.link_flair_text) meta.push(`[${post.link_flair_text}]`)
  if (meta.length) lines.push(meta.join(' | '))
  if (post.url && !post.is_self) lines.push(`Link: ${post.url}`)
  lines.push('')

  if (post.selftext && post.selftext.trim()) {
    lines.push(post.selftext.trim())
    lines.push('')
  }

  // Comments
  const commentsListing = data[1] as
    { data?: { children?: Array<{ kind: string; data: RedditComment }> } } | undefined
  const topComments = commentsListing?.data?.children ?? []
  const realComments = topComments.filter((c) => c.kind === 't1')
  if (realComments.length === 0) {
    lines.push('(no comments)')
    return lines.join('\n')
  }

  lines.push('## Comments')
  lines.push('')
  let count = 0
  for (const c of realComments) {
    if (count >= MAX_TOP_COMMENTS) break
    formatComment(c.data, 0, lines)
    count++
  }
  let out = lines.join('\n')
  if (out.length > MAX_OUTPUT_BYTES) {
    out = out.slice(0, MAX_OUTPUT_BYTES) + '\n\n…(truncated)'
  }
  return out
}

function formatComment(c: RedditComment, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return
  const indent = '  '.repeat(depth)
  const header = `${indent}[u/${c.author ?? '?'} | ${c.score ?? 0} pts]`
  out.push(header)
  const body = (c.body ?? '').trim()
  if (body) {
    for (const line of body.split('\n')) out.push(`${indent}${line}`)
  }
  out.push('')
  // Recurse into replies
  if (c.replies && typeof c.replies !== 'string') {
    const children = c.replies.data?.children ?? []
    for (const child of children) {
      if (child.kind !== 't1') continue
      formatComment(child.data, depth + 1, out)
    }
  }
}

async function tryJsonEndpoint(canonicalUrl: string): Promise<RedditResult> {
  // Strip trailing slash before adding .json
  const jsonUrl = canonicalUrl.replace(/\/$/, '') + '.json?raw_json=1'
  const fail = (error: string, bytes = 0): RedditResult => ({
    ok: false,
    content: '',
    bytes,
    canonicalUrl,
    finalUrl: jsonUrl,
    method: 'reddit-json',
    error,
  })
  try {
    const response = await fetch(jsonUrl, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return fail(`HTTP ${response.status}`)
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return fail('Non-JSON response (likely block page)', text.length)
    }
    const title = extractRedditTitle(parsed)
    return {
      ok: true,
      content: formatRedditJson(parsed),
      bytes: text.length,
      canonicalUrl,
      finalUrl: jsonUrl,
      method: 'reddit-json',
      title,
    }
  } catch (err) {
    return fail((err as Error).message)
  }
}

function extractRedditTitle(data: unknown): string | undefined {
  if (!Array.isArray(data) || data.length < 1) return undefined
  const post = (data[0] as { data?: { children?: Array<{ data?: RedditPost }> } })?.data
    ?.children?.[0]?.data
  return post?.title
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractHtmlTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return undefined
  return m[1].replace(/\s*[:|—-]\s*reddit$/i, '').trim() || undefined
}

/** Below this, a scraped Reddit page is treated as nav-chrome-only (no content). */
const MIN_CONTENT_CHARS = 200

/**
 * Depth-aware extraction of the element bearing id="main-content" — shreddit's
 * (new-reddit SSR) landmark wrapping the post and comment tree. Returns that
 * element's HTML, so the site header, footer, and "more posts" rail are left
 * behind. Returns null when the page has no such landmark (e.g. old.reddit's
 * classic markup), so the caller can fall back to the whole body.
 */
function extractMainContent(html: string): string | null {
  const open = html.match(/<(\w+)[^>]*\bid=["']main-content["']/i)
  if (!open || open.index === undefined) return null
  const tag = open[1]
  const re = new RegExp(`</?${tag}\\b`, 'gi')
  re.lastIndex = open.index + open[0].length
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth--
      if (depth === 0) return html.slice(open.index, re.lastIndex)
    } else {
      depth++
    }
  }
  return html.slice(open.index)
}

/**
 * Shreddit renders Tailwind arbitrary-variant class names (e.g.
 * `[&>:first-child]:h-full`) that survive tag-stripping and leak into the text.
 * Drop those tokens and the bare sizing utilities that trail them.
 */
function stripClassGarbage(text: string): string {
  return text
    .replace(/\S*(?:\[&|\]:|:first-child\]|rounded-\[inherit\])\S*/g, ' ')
    .replace(/\b(?:h-full|w-full|max-h-full|overflow-hidden)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Turn a scraped Reddit HTML page into readable text: prefer the #main-content
 * region (post + comments only), fall back to the whole document, then strip
 * shreddit's class-name garbage. Used by the old.reddit / FeedFetcher methods.
 */
export function extractRedditPageText(html: string): string {
  return stripClassGarbage(htmlToText(extractMainContent(html) ?? html))
}

async function tryOldReddit(canonicalUrl: string): Promise<RedditResult> {
  let oldUrl: string
  try {
    const u = new URL(canonicalUrl)
    u.host = 'old.reddit.com'
    oldUrl = u.toString()
  } catch {
    return {
      ok: false,
      content: '',
      bytes: 0,
      canonicalUrl,
      finalUrl: canonicalUrl,
      method: 'reddit-old',
      error: 'Invalid URL',
    }
  }
  const fail = (error: string): RedditResult => ({
    ok: false,
    content: '',
    bytes: 0,
    canonicalUrl,
    finalUrl: oldUrl,
    method: 'reddit-old',
    error,
  })
  try {
    const response = await fetch(oldUrl, {
      headers: { 'User-Agent': CHROME_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return fail(`HTTP ${response.status}`)
    const html = await response.text()
    if (looksBlocked(response.status, html)) return fail('blocked or empty response')
    const text = extractRedditPageText(html).slice(0, MAX_OUTPUT_BYTES)
    if (text.length < MIN_CONTENT_CHARS) return fail('nav chrome only, no content')
    return {
      ok: true,
      content: text,
      bytes: html.length,
      canonicalUrl,
      finalUrl: oldUrl,
      method: 'reddit-old',
      title: extractHtmlTitle(html),
    }
  } catch (err) {
    return fail((err as Error).message)
  }
}

export async function tryFeedFetcher(canonicalUrl: string): Promise<RedditResult> {
  const fail = (error: string): RedditResult => ({
    ok: false,
    content: '',
    bytes: 0,
    canonicalUrl,
    finalUrl: canonicalUrl,
    method: 'reddit-feedfetcher',
    error,
  })
  try {
    const response = await fetch(canonicalUrl, {
      headers: { 'User-Agent': FEEDFETCHER_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) return fail(`HTTP ${response.status}`)
    const html = await response.text()
    if (looksBlocked(response.status, html)) return fail('blocked or empty response')
    const text = extractRedditPageText(html).slice(0, MAX_OUTPUT_BYTES)
    if (text.length < MIN_CONTENT_CHARS) return fail('nav chrome only, no content')
    return {
      ok: true,
      content: text,
      bytes: html.length,
      canonicalUrl,
      finalUrl: canonicalUrl,
      method: 'reddit-feedfetcher',
      title: extractHtmlTitle(html),
    }
  } catch (err) {
    return fail((err as Error).message)
  }
}

/**
 * Reddit serves a login/interstitial wall — title "Welcome to Reddit", ~190KB
 * of `theme-beta` HTML — to requests it decides look like a scraper, and 403s
 * others. Detect the wall (and empty bodies) so the strategy chain falls
 * through to another method instead of saving the wall as if it were content.
 * Keyed on the wall's <title> and status, NOT on markers like "theme-beta" or
 * "log in" that also appear on real post pages.
 */
export function looksBlocked(status: number, body: string): boolean {
  if (status === 403 || status === 429) return true
  if (body.trim().length < 200) return true
  const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()
  if (/^Welcome to Reddit/i.test(title)) return true
  if (/blocked by network security|whoa there, pardner/i.test(body.slice(0, 4000))) return true
  return false
}

/** Decode the XML-escaped HTML that Reddit puts inside RSS <content>. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Parse Reddit's per-post Atom feed (<post>.rss) into post + comments.
 * The feed's first <entry> is the post (its <content> is the selftext); the
 * rest are comments, titled "/u/<author> on <post>". Output matches the shape
 * the JSON path produced: `# title` / `r/sub` / selftext / `## Comments`.
 */
export function parseRedditRss(xml: string): { title?: string; content: string } {
  const feedTitleRaw = decodeXmlEntities(
    (xml.match(/<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim(),
  )
  const sub = xml.match(/<category[^>]*label=["']r\/([^"']+)["']/i)?.[1] ?? ''
  // Reddit's feed title is "<post title> : <subreddit>".
  const postTitle =
    (sub
      ? feedTitleRaw.replace(new RegExp('\\s*:\\s*' + sub + '\\s*$', 'i'), '')
      : feedTitleRaw
    ).trim() || feedTitleRaw

  const entries = xml
    .split(/<entry\b/i)
    .slice(1)
    .map((e) => e.split(/<\/entry>/i)[0])
  const lines: string[] = [`# ${postTitle || '(untitled)'}`]
  if (sub) lines.push(`r/${sub}`)
  lines.push('')

  const comments: string[] = []
  for (const chunk of entries) {
    const author = decodeXmlEntities(
      (chunk.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i)?.[1] ?? '').trim(),
    )
    const eTitle = decodeXmlEntities(
      (chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim(),
    )
    const rawContent = chunk.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? ''
    const body = htmlToText(decodeXmlEntities(rawContent)).trim()
    if (!body) continue
    // Comment titles are "/u/<author> on <post>"; the post entry's title is the post title.
    const isComment = /^\/u\//i.test(eTitle) && / on /i.test(eTitle)
    if (isComment) {
      comments.push(`[${author || 'u/?'}]\n${body}`)
    } else {
      lines.push(body, '')
    }
  }

  if (comments.length) {
    lines.push('## Comments', '')
    lines.push(...comments.slice(0, MAX_TOP_COMMENTS))
  }

  let out = lines.join('\n').trim()
  if (out.length > MAX_OUTPUT_BYTES) out = out.slice(0, MAX_OUTPUT_BYTES) + '\n\n…(truncated)'
  return { title: postTitle || undefined, content: out }
}

export async function tryRssFeed(canonicalUrl: string): Promise<RedditResult> {
  const rssUrl = canonicalUrl.replace(/\/$/, '') + '.rss'
  const fail = (error: string, bytes = 0): RedditResult => ({
    ok: false,
    content: '',
    bytes,
    canonicalUrl,
    finalUrl: rssUrl,
    method: 'reddit-rss',
    error,
  })
  try {
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': FEEDFETCHER_UA,
        Accept: 'application/atom+xml, application/rss+xml, application/xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    // Reddit returns a structurally-valid Atom feed titled "<sub>: page not
    // found" with an HTTP 404 for a post it can't resolve. Guard on status like
    // the other methods do, so that placeholder feed isn't parsed and returned
    // as if it were real content (looksBlocked only catches 403/429, not 404).
    if (!response.ok) return fail(`HTTP ${response.status}`, text.length)
    if (looksBlocked(response.status, text))
      return fail(`blocked (HTTP ${response.status})`, text.length)
    if (!/<feed|<rss/i.test(text.slice(0, 300))) return fail('Non-feed response', text.length)
    const { title, content } = parseRedditRss(text)
    if (content.trim().length < 20) return fail('Empty feed content', text.length)
    return {
      ok: true,
      content,
      bytes: text.length,
      canonicalUrl,
      finalUrl: rssUrl,
      method: 'reddit-rss',
      title,
    }
  } catch (err) {
    return fail((err as Error).message)
  }
}

/**
 * Fetch a Reddit URL. Reddit walls the Chrome-UA .json/old.reddit endpoints, so
 * the primary path for a post is now its Atom feed fetched with the Google
 * FeedFetcher UA (structured post + comments, and less aggressively blocked).
 * The scrape methods remain as ordered fallbacks. Every method is guarded by
 * looksBlocked so a wall response falls through instead of being returned.
 * Resolves /s/<id> share links to canonical URLs first.
 */
export async function fetchReddit(url: string): Promise<RedditResult> {
  const resolved = await resolveCanonicalUrl(url)
  const canonical = toCanonicalPath(resolved) ?? resolved
  const isPost = toCanonicalPath(resolved) !== null

  const attempts: Array<() => Promise<RedditResult>> = []
  if (isPost) {
    attempts.push(() => tryRssFeed(canonical)) // reliable now: RSS + Google feed UA
    attempts.push(() => tryJsonEndpoint(canonical)) // structured, if Reddit ever un-walls it
  }
  attempts.push(() => tryOldReddit(canonical))
  attempts.push(() => tryFeedFetcher(canonical))

  let last: RedditResult | null = null
  for (const attempt of attempts) {
    const result = await attempt()
    if (result.ok) return result
    last = result
  }
  return (
    last ?? {
      ok: false,
      content: '',
      bytes: 0,
      canonicalUrl: canonical,
      finalUrl: canonical,
      method: 'reddit',
      error: 'all strategies failed',
    }
  )
}
