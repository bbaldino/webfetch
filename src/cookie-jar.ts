// The cookie jar: cookies exported from a real desktop browser (see export-cookies.ts),
// injected into every browser context so bot-protected sites see an aged, trusted
// visitor. The file is re-read when it changes (a copied-in jar takes effect without a
// restart), and cookies the sites rotate are written back on context close — but only
// for domains already in the jar, so it never accumulates arbitrary sites' cookies.
import { promises as fsp, readFileSync, statSync } from 'node:fs'
import type { BrowserContext, Cookie } from 'playwright-core'

const bare = (domain: string) => domain.replace(/^\./, '').toLowerCase()
const cookieKey = (c: Cookie) => `${c.name}\u0000${c.domain.toLowerCase()}\u0000${c.path}`
const live = (c: Cookie, now: number) => c.expires === -1 || c.expires > now

/**
 * What a context was seeded with: cookie key → the value and expiry injected. Handed back
 * to mergeChanged() on close, so only cookies the context actually changed are written back.
 */
export type CookieSeed = ReadonlyMap<string, { value: string; expires: number }>

// Browsers round-trip expiry at whole-second precision (the export has fractional seconds),
// so a sub-second difference is drift, not a change.
const sameExpiry = (a: number, b: number) => Math.abs(a - b) < 1

// True when d and j are the same site or one is a parent domain of the other — either
// direction, since an incoming rotated cookie may be scoped narrower or wider than
// whatever's already in the jar for that site.
const related = (d: string, j: string) => d === j || d.endsWith(`.${j}`) || j.endsWith(`.${d}`)

// Playwright rejects SameSite=None without Secure; downgrade rather than drop the cookie.
const sanitize = (c: Cookie): Cookie =>
  c.sameSite === 'None' && !c.secure ? { ...c, sameSite: 'Lax' } : c

export class CookieJar {
  private jar: Cookie[] = []
  private mtimeMs = -1
  private dirty = false
  private version = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string | undefined,
    private readonly opts: { debounceMs?: number } = {},
  ) {}

  private reloadIfChanged(): void {
    if (!this.path) return
    let mtime: number
    try {
      mtime = statSync(this.path).mtimeMs
    } catch {
      this.jar = []
      this.mtimeMs = -1
      return
    }
    if (mtime === this.mtimeMs) return
    this.mtimeMs = mtime
    this.dirty = false // an external change wins over any pending write-back
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('expected a JSON array')
      this.jar = parsed as Cookie[]
    } catch (err) {
      console.error(`cookie jar ${this.path}: ignoring malformed file (${(err as Error).name})`)
      this.jar = []
    }
  }

  cookies(): Cookie[] {
    this.reloadIfChanged()
    const now = Date.now() / 1000
    return this.jar.filter((c) => live(c, now))
  }

  domains(): Set<string> {
    return new Set(this.cookies().map((c) => bare(c.domain)))
  }

  covers(host: string): boolean {
    const h = host.toLowerCase()
    for (const d of this.domains()) if (h === d || h.endsWith(`.${d}`)) return true
    return false
  }

  /** Seed a context with the jar; returns what was injected, for mergeChanged() on close. */
  async inject(context: Pick<BrowserContext, 'addCookies'>): Promise<CookieSeed> {
    const cookies = this.cookies().map(sanitize)
    if (cookies.length > 0) await context.addCookies(cookies)
    return new Map(cookies.map((c) => [cookieKey(c), { value: c.value, expires: c.expires }]))
  }

  /**
   * Write back only what a context changed relative to its seed. Its unchanged seed copy
   * of every jar cookie is dropped, so a context closing late can't revert a rotation made
   * by another context or a jar re-delivered since it opened.
   */
  mergeChanged(seed: CookieSeed, fromContext: Cookie[]): void {
    this.reloadIfChanged()
    const current = new Map(this.jar.map((c) => [cookieKey(c), c]))
    const changed = fromContext.filter((c) => {
      const s = seed.get(cookieKey(c))
      if (!s) return true // new in this context
      if (c.value !== s.value) return true // rotated in this context
      if (sameExpiry(c.expires, s.expires)) return false // untouched seed copy
      // Same value, refreshed expiry: only worth keeping if the jar still holds that value —
      // otherwise another context (or a re-delivery) has already moved the jar past it.
      return current.get(cookieKey(c))?.value === s.value
    })
    this.merge(changed)
  }

  merge(fromContext: Cookie[]): void {
    if (!this.path) return
    this.reloadIfChanged()
    const now = Date.now() / 1000
    // Compute the jar's covered domains once (from the in-memory jar, no extra stat/read
    // per incoming cookie) rather than calling covers() — which re-derives this from a
    // fresh stat/parse — for every cookie in fromContext.
    const jarDomains = new Set(this.jar.filter((c) => live(c, now)).map((c) => bare(c.domain)))
    const covered = fromContext.filter((c) => {
      const d = bare(c.domain)
      for (const j of jarDomains) if (related(d, j)) return true
      return false
    })
    if (covered.length === 0) return
    const byKey = new Map(this.jar.map((c) => [cookieKey(c), c]))
    for (const c of covered) byKey.set(cookieKey(c), c)
    const next = [...byKey.values()].filter((c) => live(c, now))
    if (JSON.stringify(next) === JSON.stringify(this.jar)) return
    this.jar = next
    this.version++
    this.dirty = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.opts.debounceMs ?? 1000)
    this.timer.unref?.()
  }

  flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    this.writeChain = this.writeChain
      .then(() => this.writeNow())
      .catch((err: Error) =>
        console.error(`cookie jar ${this.path}: write failed (${err.message})`),
      )
    return this.writeChain
  }

  private async writeNow(): Promise<void> {
    if (!this.path || !this.dirty) return
    // Capture what we're about to write before the first await: a merge() landing while
    // this write is in flight mutates this.jar/this.version for the *next* write, not this
    // one, so it must never be silently lost.
    const capturedVersion = this.version
    const snapshot = JSON.stringify(this.jar)
    let onDisk = -1
    try {
      onDisk = (await fsp.stat(this.path)).mtimeMs
    } catch {
      /* missing */
    }
    if (onDisk !== this.mtimeMs) {
      // Someone copied a new jar in since we loaded it: theirs wins.
      this.dirty = false
      return
    }
    const tmp = `${this.path}.${process.pid}.tmp`
    await fsp.writeFile(tmp, snapshot, { mode: 0o600 })
    // Accepted race: an external copy landing between the mtime check above and this
    // rename would still be overwritten by ours. Closing that fully needs file locking,
    // which isn't worth it for a cookie jar — the hot-reload path picks up their copy on
    // the very next read anyway.
    await fsp.rename(tmp, this.path)
    this.mtimeMs = (await fsp.stat(this.path)).mtimeMs
    // Only clear dirty if nothing changed the jar while we were writing; otherwise the
    // next flush() must pick up what merge() added in the meantime.
    this.dirty = this.version !== capturedVersion
  }
}
