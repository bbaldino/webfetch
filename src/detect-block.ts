// Recognizes bot-protection walls (DataDome, Cloudflare, Akamai, PerimeterX, bare 403/429)
// from signals a page exposes, and phrases the failure for callers. Rules only fire on
// strong signatures so real pages that load bot-detection scripts aren't flagged.

export type BlockReason =
  'datadome' | 'cloudflare' | 'akamai' | 'perimeterx' | 'http-403' | 'http-429'

export interface PageSignals {
  status?: number | null
  title?: string
  text?: string
  html?: string
  frameUrls?: string[]
}

export interface BlockNotice {
  reason: BlockReason
  hint: string
}

const DATADOME_CAPTCHA = /captcha-delivery\.com\/captcha/i

export function detectBlock(s: PageSignals): BlockReason | null {
  const text = (s.text ?? '').trim()
  const html = (s.html ?? '').slice(0, 20000)
  const title = (s.title ?? '').trim()
  if ((s.frameUrls ?? []).some((u) => DATADOME_CAPTCHA.test(u))) return 'datadome'
  if (DATADOME_CAPTCHA.test(html) && text.length < 500) return 'datadome'
  if (/^Just a moment/i.test(title) && text.length < 1000) return 'cloudflare'
  if (/^Access Denied$/i.test(title) && /permission to access/i.test(text)) return 'akamai'
  if (/px-captcha/i.test(html) && text.length < 1500) return 'perimeterx'
  if ((s.status === 403 || s.status === 429) && text.length < 200)
    return s.status === 403 ? 'http-403' : 'http-429'
  return null
}

// Whether a host has cookies in the cookie jar. Registered at startup (server.ts,
// standalone.ts) so block messages can say "re-export" vs "export".
let jarCovers: (host: string) => boolean = () => false

export function setJarCoverage(fn: (host: string) => boolean): void {
  jarCovers = fn
}

export function blockNotice(url: string, reason: BlockReason): BlockNotice {
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    /* keep raw */
  }
  const site = host.replace(/^www\./, '')
  const hint = jarCovers(host)
    ? `blocked by ${site}'s bot protection (${reason}) — its cookies in the cookie jar look stale; re-export them (see README)`
    : `blocked by ${site}'s bot protection (${reason}) — if the site works in a normal browser, export its cookies into the cookie jar (see README)`
  return { reason, hint }
}
