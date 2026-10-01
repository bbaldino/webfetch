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

/** Markdown-ish text of a `.md` block: links as "text (url)", paragraphs on their own lines. */
function mdText(el: HTMLElement | null): string {
  if (!el) return ''
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#')) continue
    const url = toRedditUrl(href)
    const text = clean(a.text)
    const label = text === url ? url : `${text} (${url})`
    // The label can contain user-authored link text (e.g. "a <b> c"), which
    // set_content would otherwise parse as HTML and mangle.
    a.set_content(escapeHtml(label))
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
  const points = scorePoints(score)
  out.push(`${pad}[${[author, points].filter(Boolean).join(' · ')}]`)
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
    const meta = [author, scorePoints(score), comments ?? ''].filter(Boolean).join(' · ')
    lines.push(`- ${titleText(h)}${meta ? ` — ${meta}` : ''}`)
    if (link?.getAttribute('href')) lines.push(`  ${toRedditUrl(link.getAttribute('href')!)}`)
  }
  return { title, content: lines.join('\n').trim() }
}
