/**
 * URL rewrite hook, applied before the browser navigates/fetches a page. Redirects
 * known-heavy pages to a cheaper equivalent so the browser engine (and the resulting
 * accessibility snapshot) stays light.
 *
 * Reddit is the first rule: the `www.reddit.com` "shreddit" SPA renders to a ~20k-token
 * snapshot, while `old.reddit.com` is server-rendered lightweight HTML (~a few k). This
 * matters most under a stealth browser engine (Camoufox), where reddit is reachable via
 * the normal browser but expensive; the rewrite keeps it cheap.
 *
 * Note: this is engine-independent and only affects the *browser* path. `fetch_page`'s
 * reddit handling still short-circuits to the dedicated `fetchReddit` HTTP chain (which
 * linkding also depends on) and is unaffected.
 *
 * Extend HOST_REWRITES with more host-level rules as needed.
 */
const HOST_REWRITES: Array<{ match: RegExp; host: string }> = [
  { match: /(^|\.)reddit\.com$/i, host: 'old.reddit.com' },
]

/** Rewrite a URL's host per HOST_REWRITES. Returns the input unchanged if no rule matches or it can't be parsed. */
export function rewriteUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  for (const rule of HOST_REWRITES) {
    if (rule.match.test(u.hostname)) {
      u.hostname = rule.host
      return u.toString()
    }
  }
  return raw
}
