// The cookie jar: cookies exported from a real desktop browser (see export-cookies.ts),
// injected into every browser context so bot-protected sites see an aged, trusted
// visitor. The file is re-read when it changes (a copied-in jar takes effect without a
// restart), and cookies the sites rotate are written back on context close — but only
// for domains already in the jar, so it never accumulates arbitrary sites' cookies.
import { promises as fsp, readFileSync, statSync } from 'node:fs'
import type { BrowserContext, Cookie } from 'playwright-core'

const bare = (domain: string) => domain.replace(/^\./, '').toLowerCase()
const cookieKey = (c: Cookie) => `${c.name}\u0000${c.domain}\u0000${c.path}`
const live = (c: Cookie, now: number) => c.expires === -1 || c.expires > now

// Playwright rejects SameSite=None without Secure; downgrade rather than drop the cookie.
const sanitize = (c: Cookie): Cookie =>
  c.sameSite === 'None' && !c.secure ? { ...c, sameSite: 'Lax' } : c

export class CookieJar {
  private jar: Cookie[] = []
  private mtimeMs = -1
  private dirty = false
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

  async inject(context: Pick<BrowserContext, 'addCookies'>): Promise<void> {
    const cookies = this.cookies()
    if (cookies.length > 0) await context.addCookies(cookies.map(sanitize))
  }

  merge(fromContext: Cookie[]): void {
    if (!this.path) return
    this.reloadIfChanged()
    const covered = fromContext.filter((c) => this.covers(bare(c.domain)))
    if (covered.length === 0) return
    const byKey = new Map(this.jar.map((c) => [cookieKey(c), c]))
    for (const c of covered) byKey.set(cookieKey(c), c)
    const now = Date.now() / 1000
    const next = [...byKey.values()].filter((c) => live(c, now))
    if (JSON.stringify(next) === JSON.stringify(this.jar)) return
    this.jar = next
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
    await fsp.writeFile(tmp, JSON.stringify(this.jar), { mode: 0o600 })
    await fsp.rename(tmp, this.path)
    this.mtimeMs = (await fsp.stat(this.path)).mtimeMs
    this.dirty = false
  }
}
