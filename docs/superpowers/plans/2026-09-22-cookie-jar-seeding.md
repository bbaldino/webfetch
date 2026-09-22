# Cookie-Jar Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a cookie jar exported from a real desktop Chrome into every Camoufox context so DataDome-protected sites (Yelp, incl. search) work, and report blocked pages as errors instead of empty successes.

**Architecture:** A `CookieJar` (file on `/data`, hot-reloaded, written back on context close) is handed to `BrowserManager`, the single place contexts are created — so `fetch_page`, `/sessions` and the MCP tools all get it. A pure `detectBlock` recognizes bot walls; `fetch_page` turns them into errors and the browse envelope gains an optional `blocked` field. A desktop CLI (`npm run export-cookies`) decrypts Chrome's cookies for chosen domains into the jar format.

**Tech Stack:** TypeScript (TS 7), Node (`node:crypto`, `node:fs`, `node:util` `parseArgs`), `better-sqlite3` (existing dep), `playwright-core` + Camoufox, `vitest`.

**Spec:** `docs/superpowers/specs/2026-09-22-cookie-jar-seeding-design.md`

## Global Constraints

- **No new dependencies.** Use `better-sqlite3` (already a dep) and Node built-ins.
- **Prettier** (`.prettierrc`: `singleQuote: true`, `semi: false`, `printWidth: 100`) — run `npx prettier --write` on changed files before committing.
- `npm run lint` (oxlint) and `npm run typecheck` (`tsc --noEmit`) must be clean; `npm test` must stay green.
- **ESM:** relative imports use the `.js` extension.
- **Acronym casing:** capitalize only the first letter of multi-letter acronyms in new identifiers.
- **Never log cookie values** or the keyring secret. Log messages may name the jar path and domains only.
- **Jar file:** path from `WEBFETCH_COOKIE_JAR`, default `/data/cookies.json`; JSON array of Playwright `Cookie` objects; written mode `600` via temp file + rename.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Ruling (deviation from spec):** the export tool lives in `src/` (`src/chrome-cookies.ts` + `src/export-cookies.ts`), not `scripts/`, because `tsconfig.json` only compiles `src/` (`rootDir: "src"`). Behavior is as specced.

## File Structure

- **Create** `src/detect-block.ts` — `detectBlock(signals)`, `blockNotice(url, reason)`, `setJarCoverage(fn)`.
- **Create** `src/detect-block.test.ts`
- **Create** `src/cookie-jar.ts` — `CookieJar` class.
- **Create** `src/cookie-jar.test.ts`
- **Create** `src/chrome-cookies.ts` — pure Chrome-cookie decryption + jar merge.
- **Create** `src/chrome-cookies.test.ts`
- **Create** `src/export-cookies.ts` — desktop CLI.
- **Create** `src/cookie-jar.integration.test.ts` — gated live Yelp test.
- **Modify** `src/browser-manager.ts` — accept a jar, inject on context create, `closeContext()` writes back, flush on `close()`, test seam for launching.
- **Create** `src/browser-manager.test.ts`
- **Modify** `src/tools.ts` — `browserFetch` uses `closeContext`, block detection, non-empty error messages.
- **Modify** `src/browse.ts` — envelope gains optional `blocked`.
- **Modify** `src/routes.ts` — `/fetch` treats any defined `error` as failure.
- **Modify** `src/openapi.ts` — `BrowseResult.blocked`.
- **Modify** `src/server.ts`, `src/standalone.ts` — construct the jar, register coverage, pass to `BrowserManager`.
- **Modify** `package.json` — `export-cookies` and `test:integration:yelp` scripts.
- **Modify** `README.md` — "Sites behind bot protection" section.

---

### Task 1: Block detection (`src/detect-block.ts`)

**Files:**

- Create: `src/detect-block.ts`, `src/detect-block.test.ts`

**Interfaces:**

- Produces:
  - `type BlockReason = 'datadome' | 'cloudflare' | 'akamai' | 'perimeterx' | 'http-403' | 'http-429'`
  - `interface PageSignals { status?: number | null; title?: string; text?: string; html?: string; frameUrls?: string[] }`
  - `detectBlock(s: PageSignals): BlockReason | null`
  - `interface BlockNotice { reason: BlockReason; hint: string }`
  - `blockNotice(url: string, reason: BlockReason): BlockNotice`
  - `setJarCoverage(fn: (host: string) => boolean): void`

- [ ] **Step 1: Write the failing test** (`src/detect-block.test.ts`)

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { detectBlock, blockNotice, setJarCoverage } from './detect-block.js'

afterEach(() => setJarCoverage(() => false))

describe('detectBlock', () => {
  it('flags a DataDome challenge by its captcha iframe', () => {
    expect(
      detectBlock({
        title: 'yelp.com',
        text: '',
        frameUrls: [
          'https://www.yelp.com/biz/x',
          'https://geo.captcha-delivery.com/captcha/?initialCid=abc',
        ],
      }),
    ).toBe('datadome')
  })

  it('flags a DataDome block page by its html', () => {
    expect(
      detectBlock({
        html: '<html><head><title>yelp.com</title></head><body><iframe src="https://geo.captcha-delivery.com/captcha/?x=1"></iframe></body></html>',
        text: '',
      }),
    ).toBe('datadome')
  })

  it('flags a Cloudflare interstitial by title with little text', () => {
    expect(detectBlock({ title: 'Just a moment...', text: 'Checking your browser' })).toBe(
      'cloudflare',
    )
  })

  it('flags an Akamai access-denied page', () => {
    expect(
      detectBlock({
        title: 'Access Denied',
        text: "You don't have permission to access this resource. Reference #18.abc",
      }),
    ).toBe('akamai')
  })

  it('flags a PerimeterX press-and-hold page', () => {
    expect(
      detectBlock({
        html: '<div id="px-captcha"></div>',
        text: 'Press & Hold to confirm you are a human',
      }),
    ).toBe('perimeterx')
  })

  it('flags a 403/429 with an almost-empty body', () => {
    expect(detectBlock({ status: 403, text: '' })).toBe('http-403')
    expect(detectBlock({ status: 429, text: 'slow down' })).toBe('http-429')
  })

  it('does not flag real pages that merely mention captcha or load bot scripts', () => {
    const text = 'x'.repeat(5000) + ' we use a captcha on our signup form'
    expect(
      detectBlock({
        status: 200,
        title: 'Gary Danko - Yelp',
        text,
        html: '<script src="https://js.datadome.co/tags.js"></script>',
      }),
    ).toBeNull()
    expect(detectBlock({ status: 403, text: 'x'.repeat(2000) })).toBeNull()
  })
})

describe('blockNotice', () => {
  it('says the jar looks stale when the host is covered by the jar', () => {
    setJarCoverage((h) => h.endsWith('yelp.com'))
    const n = blockNotice('https://www.yelp.com/biz/x', 'datadome')
    expect(n.reason).toBe('datadome')
    expect(n.hint).toContain("yelp.com's bot protection")
    expect(n.hint).toContain('look stale')
  })

  it('suggests exporting cookies when the host is not covered', () => {
    const n = blockNotice('https://www.wayfair.com/', 'perimeterx')
    expect(n.hint).toContain("wayfair.com's bot protection")
    expect(n.hint).toContain('export')
    expect(n.hint).not.toContain('look stale')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/detect-block.test.ts`
Expected: FAIL — `detect-block.js` does not exist.

- [ ] **Step 3: Write `src/detect-block.ts`**

```ts
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
  if ((s.status === 403 || s.status === 429) && text.length < 200) return `http-${s.status}`
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
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run src/detect-block.test.ts && npm run typecheck && npm run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/detect-block.ts src/detect-block.test.ts
git add src/detect-block.ts src/detect-block.test.ts
git commit -m "$(printf 'feat: detect bot-protection walls and phrase block notices\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `CookieJar` (`src/cookie-jar.ts`)

**Files:**

- Create: `src/cookie-jar.ts`, `src/cookie-jar.test.ts`

**Interfaces:**

- Consumes: `Cookie`, `BrowserContext` types from `playwright-core`.
- Produces: `class CookieJar` with
  - `constructor(path: string | undefined, opts?: { debounceMs?: number })`
  - `cookies(): Cookie[]` (hot-reloads on mtime change; excludes expired)
  - `domains(): Set<string>` (cookie domains without the leading dot)
  - `covers(host: string): boolean`
  - `inject(context: Pick<BrowserContext, 'addCookies'>): Promise<void>`
  - `merge(fromContext: Cookie[]): void` (only jar-covered domains; upsert by name+domain+path; drop expired; schedules a debounced write)
  - `flush(): Promise<void>` (never rejects)

- [ ] **Step 1: Write the failing test** (`src/cookie-jar.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Cookie } from 'playwright-core'
import { CookieJar } from './cookie-jar.js'

const future = Date.now() / 1000 + 86400
const ck = (name: string, domain: string, value = 'v', expires = future): Cookie => ({
  name,
  value,
  domain,
  path: '/',
  expires,
  httpOnly: false,
  secure: true,
  sameSite: 'Lax',
})

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jar-'))
  path = join(dir, 'cookies.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const bump = (p: string) => {
  const t = new Date(Date.now() + 5000)
  utimesSync(p, t, t)
}

describe('CookieJar', () => {
  it('treats a missing file as an empty jar', () => {
    const jar = new CookieJar(path)
    expect(jar.cookies()).toEqual([])
    expect(jar.covers('www.yelp.com')).toBe(false)
  })

  it('loads cookies, drops expired ones, and derives covered domains', () => {
    writeFileSync(
      path,
      JSON.stringify([ck('datadome', '.yelp.com'), ck('old', '.yelp.com', 'v', 1)]),
    )
    const jar = new CookieJar(path)
    expect(jar.cookies().map((c) => c.name)).toEqual(['datadome'])
    expect([...jar.domains()]).toEqual(['yelp.com'])
    expect(jar.covers('www.yelp.com')).toBe(true)
    expect(jar.covers('yelp.com')).toBe(true)
    expect(jar.covers('notyelp.com')).toBe(false)
  })

  it('hot-reloads when the file changes', () => {
    writeFileSync(path, JSON.stringify([ck('a', '.yelp.com')]))
    const jar = new CookieJar(path)
    expect(jar.cookies().map((c) => c.name)).toEqual(['a'])
    writeFileSync(path, JSON.stringify([ck('b', '.yelp.com')]))
    bump(path)
    expect(jar.cookies().map((c) => c.name)).toEqual(['b'])
  })

  it('treats a malformed file as empty and warns without the contents', () => {
    writeFileSync(path, '{not json')
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(new CookieJar(path).cookies()).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).not.toContain('{not json')
    warn.mockRestore()
  })

  it('merge keeps only covered domains, upserts, and flush writes atomically with mode 600', async () => {
    writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'old')]))
    const jar = new CookieJar(path, { debounceMs: 10_000 })
    jar.cookies()
    jar.merge([ck('datadome', '.yelp.com', 'new'), ck('tracker', '.doubleclick.net')])
    await jar.flush()
    const written = JSON.parse(readFileSync(path, 'utf8')) as Cookie[]
    expect(written).toEqual([ck('datadome', '.yelp.com', 'new')])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
  })

  it('an external copy made after a merge wins over the pending write-back', async () => {
    writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'old')]))
    const jar = new CookieJar(path, { debounceMs: 10_000 })
    jar.cookies()
    jar.merge([ck('datadome', '.yelp.com', 'rotated')])
    writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'fresh-export')]))
    bump(path)
    await jar.flush()
    expect((JSON.parse(readFileSync(path, 'utf8')) as Cookie[])[0].value).toBe('fresh-export')
  })

  it('never creates a file when the jar is empty', async () => {
    const jar = new CookieJar(path, { debounceMs: 0 })
    jar.merge([ck('x', '.yelp.com')])
    await jar.flush()
    expect(existsSync(path)).toBe(false)
  })

  it('inject adds sanitized cookies to a context', async () => {
    writeFileSync(
      path,
      JSON.stringify([{ ...ck('a', '.yelp.com'), sameSite: 'None', secure: false }]),
    )
    const added: Cookie[][] = []
    await new CookieJar(path).inject({ addCookies: async (c) => void added.push(c as Cookie[]) })
    expect(added[0][0].sameSite).toBe('Lax') // SameSite=None requires Secure; downgrade instead of throwing
  })

  it('a jar with no path is inert', async () => {
    const jar = new CookieJar(undefined)
    jar.merge([ck('a', '.yelp.com')])
    await jar.flush()
    expect(jar.cookies()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cookie-jar.test.ts`
Expected: FAIL — `cookie-jar.js` does not exist.

- [ ] **Step 3: Write `src/cookie-jar.ts`**

```ts
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
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run src/cookie-jar.test.ts && npm run typecheck && npm run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cookie-jar.ts src/cookie-jar.test.ts
git add src/cookie-jar.ts src/cookie-jar.test.ts
git commit -m "$(printf 'feat: CookieJar — hot-reloaded jar with scoped write-back\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Chrome cookie export (`src/chrome-cookies.ts`, `src/export-cookies.ts`)

**Files:**

- Create: `src/chrome-cookies.ts`, `src/chrome-cookies.test.ts`, `src/export-cookies.ts`
- Modify: `package.json` (add `"export-cookies": "tsx src/export-cookies.ts"`)

**Interfaces:**

- Consumes: `better-sqlite3`, `node:crypto`, `Cookie` type from `playwright-core`.
- Produces:
  - `deriveKey(secret: string): Buffer`
  - `class WrongSecretError extends Error`
  - `decryptValue(blob: Buffer, hostKey: string, keys: { v10: Buffer; v11?: Buffer }, schema: number): string`
  - `chromeTimeToUnix(us: number): number` (0 → -1)
  - `chromeSameSite(code: number): Cookie['sameSite']` (0→None, 2→Strict, else Lax)
  - `matchesDomain(hostKey: string, domain: string): boolean`
  - `readChromeCookies(dbPath: string, opts: { secret?: string; domains: string[] }): Cookie[]`
  - `mergeJar(existing: Cookie[], fresh: Cookie[], domains: string[]): Cookie[]` (drops existing cookies for those domains, adds fresh)

- [ ] **Step 1: Write the failing test** (`src/chrome-cookies.test.ts`)

Build a synthetic Chrome `Cookies` DB with a known secret.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createCipheriv, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Cookie } from 'playwright-core'
import {
  deriveKey,
  decryptValue,
  WrongSecretError,
  chromeTimeToUnix,
  chromeSameSite,
  matchesDomain,
  readChromeCookies,
  mergeJar,
} from './chrome-cookies.js'

const SECRET = 'test-keyring-secret'
function encrypt(
  value: string,
  host: string,
  secret: string,
  prefix: 'v10' | 'v11',
  schema: number,
): Buffer {
  const plain =
    schema >= 24
      ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
      : Buffer.from(value)
  const c = createCipheriv('aes-128-cbc', deriveKey(secret), Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from(prefix), c.update(plain), c.final()])
}

let dir: string
let db: string
function makeDb(schema: number, rows: Array<[string, string, Buffer, number, number]>) {
  db = join(dir, 'Cookies')
  const d = new Database(db)
  d.exec(`CREATE TABLE meta(key TEXT, value TEXT);
          CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
            expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);`)
  d.prepare(`INSERT INTO meta VALUES ('version', ?)`).run(String(schema))
  const ins = d.prepare(`INSERT INTO cookies VALUES (?, ?, '', ?, '/', ?, 1, 1, ?)`)
  for (const r of rows) ins.run(...r)
  d.close()
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chrome-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// 2026-01-01T00:00:00Z in Chrome's microseconds-since-1601
const CHROME_2026 = (1767225600 + 11644473600) * 1e6

describe('decryptValue', () => {
  it('decrypts v11 with the keyring secret and strips the schema-24 host hash', () => {
    const blob = encrypt('dd-token', '.yelp.com', SECRET, 'v11', 24)
    expect(
      decryptValue(blob, '.yelp.com', { v10: deriveKey('peanuts'), v11: deriveKey(SECRET) }, 24),
    ).toBe('dd-token')
  })
  it('throws WrongSecretError for the wrong secret', () => {
    const blob = encrypt('dd-token', '.yelp.com', SECRET, 'v11', 24)
    expect(() =>
      decryptValue(blob, '.yelp.com', { v10: deriveKey('peanuts'), v11: deriveKey('nope') }, 24),
    ).toThrow(WrongSecretError)
  })
  it('decrypts v10 (basic store) with the peanuts key and pre-24 schemas without a prefix', () => {
    const blob = encrypt('plainish', '.yelp.com', 'peanuts', 'v10', 23)
    expect(decryptValue(blob, '.yelp.com', { v10: deriveKey('peanuts') }, 23)).toBe('plainish')
  })
  it('errors on v11 when no keyring secret is available', () => {
    const blob = encrypt('x', '.yelp.com', SECRET, 'v11', 24)
    expect(() => decryptValue(blob, '.yelp.com', { v10: deriveKey('peanuts') }, 24)).toThrow(
      WrongSecretError,
    )
  })
})

describe('conversions', () => {
  it('converts Chrome timestamps and SameSite codes', () => {
    expect(chromeTimeToUnix(0)).toBe(-1)
    expect(chromeTimeToUnix(CHROME_2026)).toBe(1767225600)
    expect(chromeSameSite(0)).toBe('None')
    expect(chromeSameSite(1)).toBe('Lax')
    expect(chromeSameSite(2)).toBe('Strict')
    expect(chromeSameSite(-1)).toBe('Lax')
  })
  it('matches a domain and its subdomains only', () => {
    expect(matchesDomain('.yelp.com', 'yelp.com')).toBe(true)
    expect(matchesDomain('business.yelp.com', 'yelp.com')).toBe(true)
    expect(matchesDomain('notyelp.com', 'yelp.com')).toBe(false)
  })
})

describe('readChromeCookies', () => {
  it('reads only the requested domains, decrypted, in Playwright format', () => {
    makeDb(24, [
      ['.yelp.com', 'datadome', encrypt('dd', '.yelp.com', SECRET, 'v11', 24), CHROME_2026, 0],
      ['.google.com', 'SID', encrypt('g', '.google.com', SECRET, 'v11', 24), CHROME_2026, 1],
    ])
    const out = readChromeCookies(db, { secret: SECRET, domains: ['yelp.com'] })
    expect(out).toEqual([
      {
        name: 'datadome',
        value: 'dd',
        domain: '.yelp.com',
        path: '/',
        expires: 1767225600,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
    ])
  })
})

describe('mergeJar', () => {
  const c = (name: string, domain: string): Cookie => ({
    name,
    value: 'v',
    domain,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
  })
  it('replaces the exported domains and keeps the rest', () => {
    const merged = mergeJar(
      [c('old', '.yelp.com'), c('keep', '.other.com')],
      [c('new', '.yelp.com')],
      ['yelp.com'],
    )
    expect(merged.map((x) => x.name).sort()).toEqual(['keep', 'new'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chrome-cookies.test.ts`
Expected: FAIL — `chrome-cookies.js` does not exist.

- [ ] **Step 3: Write `src/chrome-cookies.ts`**

```ts
// Reads and decrypts a desktop Chrome (Linux) Cookies database into Playwright cookies.
// Linux Chrome encrypts values with a key derived from the keyring secret ("v11") or, with
// no keyring, the fixed "peanuts" password ("v10"). DB schema >= 24 prefixes each
// plaintext with SHA256(host_key), which doubles as a check that the secret is right.
import Database from 'better-sqlite3'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Cookie } from 'playwright-core'

export class WrongSecretError extends Error {}

export const deriveKey = (secret: string): Buffer => pbkdf2Sync(secret, 'saltysalt', 1, 16, 'sha1')

export function decryptValue(
  blob: Buffer,
  hostKey: string,
  keys: { v10: Buffer; v11?: Buffer },
  schema: number,
): string {
  const prefix = blob.subarray(0, 3).toString()
  if (prefix !== 'v10' && prefix !== 'v11') return blob.toString('utf8')
  const key = prefix === 'v10' ? keys.v10 : keys.v11
  if (!key)
    throw new WrongSecretError('cookie is keyring-encrypted but no keyring secret is available')
  let plain: Buffer
  try {
    const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    plain = Buffer.concat([d.update(blob.subarray(3)), d.final()])
  } catch {
    throw new WrongSecretError('decryption failed — wrong keyring secret?')
  }
  if (schema >= 24) {
    if (!plain.subarray(0, 32).equals(createHash('sha256').update(hostKey).digest())) {
      throw new WrongSecretError('host hash mismatch — wrong keyring secret')
    }
    plain = plain.subarray(32)
  }
  return plain.toString('utf8')
}

export const chromeTimeToUnix = (us: number): number => (us === 0 ? -1 : us / 1e6 - 11644473600)

export const chromeSameSite = (code: number): Cookie['sameSite'] =>
  code === 0 ? 'None' : code === 2 ? 'Strict' : 'Lax'

const bare = (d: string) => d.replace(/^\./, '').toLowerCase()

export function matchesDomain(hostKey: string, domain: string): boolean {
  const h = bare(hostKey)
  const d = bare(domain)
  return h === d || h.endsWith(`.${d}`)
}

interface Row {
  host_key: string
  name: string
  value: string
  encrypted_value: Buffer
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
}

export function readChromeCookies(
  dbPath: string,
  opts: { secret?: string; domains: string[] },
): Cookie[] {
  // Chrome keeps the DB locked while running: read a copy.
  const dir = mkdtempSync(join(tmpdir(), 'webfetch-cookies-'))
  try {
    const copy = join(dir, 'Cookies')
    copyFileSync(dbPath, copy)
    if (existsSync(`${dbPath}-journal`)) copyFileSync(`${dbPath}-journal`, `${copy}-journal`)
    const db = new Database(copy, { readonly: true })
    try {
      const schema = Number(
        (db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get() as { value: string })
          .value,
      )
      const keys = {
        v10: deriveKey('peanuts'),
        v11: opts.secret ? deriveKey(opts.secret) : undefined,
      }
      const rows = db
        .prepare(
          `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies`,
        )
        .all() as Row[]
      return rows
        .filter((r) => opts.domains.some((d) => matchesDomain(r.host_key, d)))
        .map((r) => ({
          name: r.name,
          value: r.encrypted_value?.length
            ? decryptValue(r.encrypted_value, r.host_key, keys, schema)
            : r.value,
          domain: r.host_key,
          path: r.path,
          expires: chromeTimeToUnix(r.expires_utc),
          httpOnly: r.is_httponly === 1,
          secure: r.is_secure === 1,
          sameSite: chromeSameSite(r.samesite),
        }))
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function mergeJar(existing: Cookie[], fresh: Cookie[], domains: string[]): Cookie[] {
  const kept = existing.filter((c) => !domains.some((d) => matchesDomain(c.domain, d)))
  return [...kept, ...fresh]
}
```

- [ ] **Step 4: Write `src/export-cookies.ts`** (the CLI; covered by the pure tests above)

```ts
// Desktop CLI: export a real Chrome's cookies for chosen domains into a webfetch cookie
// jar. Run where the site works in a normal browser:
//   npm run export-cookies -- --domain yelp.com [--domain x.com] [--profile DIR] [--out FILE] [--secret-file FILE]
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Cookie } from 'playwright-core'
import { mergeJar, readChromeCookies, WrongSecretError } from './chrome-cookies.js'

const { values } = parseArgs({
  options: {
    domain: { type: 'string', multiple: true },
    profile: { type: 'string', default: join(homedir(), '.config/google-chrome/Default') },
    out: { type: 'string', default: 'cookies.json' },
    'secret-file': { type: 'string' },
  },
})
const domains = values.domain ?? []
if (domains.length === 0) {
  console.error(
    'usage: export-cookies --domain yelp.com [--domain ...] [--profile DIR] [--out FILE] [--secret-file FILE]',
  )
  process.exit(2)
}

const dbPath = [join(values.profile, 'Network/Cookies'), join(values.profile, 'Cookies')].find(
  existsSync,
)
if (!dbPath) {
  console.error(`no Chrome Cookies database under ${values.profile}`)
  process.exit(1)
}

function keyringSecret(): string | undefined {
  if (values['secret-file']) return readFileSync(values['secret-file'], 'utf8').trim()
  try {
    return (
      execFileSync('secret-tool', ['lookup', 'application', 'chrome'], {
        encoding: 'utf8',
      }).trim() || undefined
    )
  } catch {
    return undefined
  }
}

let fresh: Cookie[]
try {
  fresh = readChromeCookies(dbPath, { secret: keyringSecret(), domains })
} catch (err) {
  if (err instanceof WrongSecretError) {
    console.error(`could not decrypt Chrome's cookies: ${err.message}`)
    process.exit(1)
  }
  throw err
}

const existing: Cookie[] = existsSync(values.out)
  ? JSON.parse(readFileSync(values.out, 'utf8'))
  : []
writeFileSync(values.out, JSON.stringify(mergeJar(existing, fresh, domains)), { mode: 0o600 })
chmodSync(values.out, 0o600)

for (const d of domains) {
  console.log(
    `${d}: ${fresh.filter((c) => c.domain.replace(/^\./, '').endsWith(d)).length} cookies`,
  )
}
console.log(`\nwrote ${values.out}. Copy it to webfetch with:`)
console.log(
  `  cat ${values.out} | ssh docker 'docker exec -i webfetch sh -c "cat > /data/cookies.json && chmod 600 /data/cookies.json"'`,
)
```

Add to `package.json` scripts: `"export-cookies": "tsx src/export-cookies.ts"`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `npx vitest run src/chrome-cookies.test.ts && npm run typecheck && npm run lint && npm test`
Expected: PASS; clean; full suite green.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/chrome-cookies.ts src/chrome-cookies.test.ts src/export-cookies.ts package.json
git add src/chrome-cookies.ts src/chrome-cookies.test.ts src/export-cookies.ts package.json
git commit -m "$(printf 'feat: export-cookies CLI to build a jar from desktop Chrome\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Wire the jar into `BrowserManager`

**Files:**

- Modify: `src/browser-manager.ts`, `src/tools.ts` (`browserFetch` closes via `closeContext`), `src/server.ts`, `src/standalone.ts`
- Create: `src/browser-manager.test.ts`

**Interfaces:**

- Consumes: `CookieJar` (Task 2), `setJarCoverage` (Task 1).
- Produces: `BrowserManager` constructor `opts: { headless?: boolean; jar?: CookieJar; launch?: () => Promise<Browser> }` (`launch` is a test seam; default launches Camoufox as today), and `closeContext(context: BrowserContext): Promise<void>`.

- [ ] **Step 1: Write the failing test** (`src/browser-manager.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import type { Cookie } from 'playwright-core'
import { BrowserManager } from './browser-manager.js'

const ck = (name: string, value = 'v'): Cookie => ({
  name,
  value,
  domain: '.yelp.com',
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: true,
  sameSite: 'Lax',
})

function fakeJar() {
  return {
    injected: 0,
    merged: [] as Cookie[][],
    flushed: 0,
    async inject() {
      this.injected++
    },
    merge(c: Cookie[]) {
      this.merged.push(c)
    },
    async flush() {
      this.flushed++
    },
  }
}
function fakeBrowser() {
  const contexts: Array<{ closed: boolean }> = []
  return {
    contexts,
    isConnected: () => true,
    close: async () => {},
    newContext: async () => {
      const ctx = {
        closed: false,
        cookies: async () => [ck('datadome', 'rotated')],
        addCookies: async () => {},
        newPage: async () => ({ isClosed: () => false }),
        close: async () => {
          ctx.closed = true
        },
      }
      contexts.push(ctx)
      return ctx
    },
  }
}

describe('BrowserManager cookie jar', () => {
  it('injects the jar into session and temp contexts', async () => {
    const jar = fakeJar()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => fakeBrowser() as never })
    await bm.getSession('s1')
    await bm.createTempPage()
    expect(jar.injected).toBe(2)
  })

  it('writes cookies back before closing a context, and flushes on shutdown', async () => {
    const jar = fakeJar()
    const browser = fakeBrowser()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const { context } = await bm.createTempPage()
    await bm.closeContext(context)
    await bm.getSession('s1')
    await bm.close()
    expect(jar.merged.length).toBe(2) // temp context + session context
    expect(jar.merged[0][0].value).toBe('rotated')
    expect(browser.contexts.every((c) => c.closed)).toBe(true)
    expect(jar.flushed).toBe(1)
  })

  it('works without a jar', async () => {
    const bm = new BrowserManager({ launch: async () => fakeBrowser() as never })
    const { context } = await bm.createTempPage()
    await expect(bm.closeContext(context)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browser-manager.test.ts`
Expected: FAIL — `jar`/`launch` options and `closeContext` don't exist.

- [ ] **Step 3: Modify `src/browser-manager.ts`**

- Add `import type { CookieJar } from './cookie-jar.js'`.
- Constructor: `constructor(opts: { headless?: boolean; jar?: CookieJar; launch?: () => Promise<Browser> } = {})`; store `this.jar = opts.jar` and `this.launchFn = opts.launch`.
- In `ensureBrowser()`: `this.browser = this.launchFn ? await this.launchFn() : await firefox.launch(options)` (build `options` only when `launchFn` is absent).
- Add a private helper used by both `getSession` and `createTempPage` in place of `browser.newContext()`:

```ts
  private async newContext(): Promise<BrowserContext> {
    const browser = await this.ensureBrowser()
    const context = await browser.newContext()
    // Seed every context with the cookie jar so bot-protected sites see a trusted visitor.
    await this.jar?.inject(context).catch((err: Error) => console.error(`cookie jar inject failed: ${err.message}`))
    return context
  }

  /** Close a context, first writing any cookies the sites rotated back to the jar. */
  async closeContext(context: BrowserContext): Promise<void> {
    if (this.jar) {
      try {
        this.jar.merge(await context.cookies())
      } catch {
        /* best-effort: never fail a close over write-back */
      }
    }
    await context.close().catch(() => {})
  }
```

- `closeSession()` calls `await this.closeContext(session.context)` instead of `session.context.close()`.
- `close()`: after closing sessions and before closing the browser, `await this.jar?.flush()`.

- [ ] **Step 4: `src/tools.ts` — close temp contexts through the manager**

In `browserFetch`, type `context` as `BrowserContext | undefined` (import the type from `playwright-core`) and replace the `finally` with `if (context) await browserManager.closeContext(context)`.

- [ ] **Step 5: Construct the jar in `src/server.ts` and `src/standalone.ts`**

```ts
import { CookieJar } from './cookie-jar.js'
import { setJarCoverage } from './detect-block.js'
// ...
// Cookies exported from a real browser (npm run export-cookies); missing file = empty jar.
const jar = new CookieJar(process.env.WEBFETCH_COOKIE_JAR ?? '/data/cookies.json')
setJarCoverage((host) => jar.covers(host))
const browserManager = new BrowserManager({ headless, jar })
```

(Shutdown already awaits `browserManager.close()`, which now flushes the jar.)

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npx vitest run src/browser-manager.test.ts && npm run typecheck && npm run lint && npm test`
Expected: PASS; clean; full suite green.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/browser-manager.ts src/browser-manager.test.ts src/tools.ts src/server.ts src/standalone.ts
git add src/browser-manager.ts src/browser-manager.test.ts src/tools.ts src/server.ts src/standalone.ts
git commit -m "$(printf 'feat: seed every browser context from the cookie jar\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Honest failures and the `blocked` envelope field

**Files:**

- Modify: `src/tools.ts` (`browserFetch` → pure `browserOutcome`), `src/routes.ts`, `src/browse.ts`, `src/openapi.ts`
- Modify: `src/browse.test.ts` (envelope `blocked`), `src/routes.test.ts` (`/fetch` error mapping)
- Create: `src/browser-outcome.test.ts` (or add to an existing tools test file)

**Interfaces:**

- Consumes: `detectBlock`, `blockNotice`, `BlockNotice` (Task 1).
- Produces:
  - `export function browserOutcome(url: string, signals: PageSignals & { text: string; finalUrl: string; title: string }): FetchOutcome` in `src/tools.ts` — `ok: false` with a non-empty message in `content` for a detected block (`blockNotice(...).hint`) or for empty text (`no content extracted from <host>`); otherwise the current success shape.
  - `BrowseResult` gains `blocked?: BlockNotice`.

- [ ] **Step 1: Write the failing tests**

`src/browser-outcome.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { browserOutcome } from './tools.js'
import { setJarCoverage } from './detect-block.js'

afterEach(() => setJarCoverage(() => false))
const base = { finalUrl: 'https://www.yelp.com/biz/x', title: 'yelp.com' }

describe('browserOutcome', () => {
  it('reports a DataDome wall as a failure with a stale-jar hint when the jar covers the site', () => {
    setJarCoverage((h) => h.endsWith('yelp.com'))
    const o = browserOutcome('https://www.yelp.com/biz/x', {
      ...base,
      status: 403,
      text: '',
      frameUrls: ['https://geo.captcha-delivery.com/captcha/?a=1'],
    })
    expect(o.ok).toBe(false)
    expect(o.content).toContain('look stale')
  })
  it('never reports empty content as success', () => {
    const o = browserOutcome('https://example.org/', {
      ...base,
      finalUrl: 'https://example.org/',
      status: 200,
      text: '',
    })
    expect(o.ok).toBe(false)
    expect(o.content).toBe('no content extracted from example.org')
  })
  it('passes real content through', () => {
    const o = browserOutcome('https://example.org/', { ...base, status: 200, text: 'hello world' })
    expect(o).toMatchObject({ ok: true, content: 'hello world', bytes: 11 })
  })
})
```

In `src/browse.test.ts`, add (extend `mockPage` with a `frames` override):

```ts
it('adds a blocked notice to the envelope when the page is a bot wall', async () => {
  const { page } = mockPage({
    frames: () => [{ url: () => 'https://geo.captcha-delivery.com/captcha/?x' }],
  })
  const r = await browse.snapshot(page as never)
  expect(r.blocked?.reason).toBe('datadome')
})
it('omits blocked for normal pages', async () => {
  const { page } = mockPage()
  expect((await browse.snapshot(page as never)).blocked).toBeUndefined()
})
```

In `src/routes.test.ts`, add: a stub `fetchPage` returning `{ url, method: 'browser', error: '' }` → `POST /fetch` responds `502` (not `200`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/browser-outcome.test.ts src/browse.test.ts src/routes.test.ts`
Expected: FAIL — `browserOutcome` missing; `blocked` absent; empty error returns 200.

- [ ] **Step 3: Implement**

`src/tools.ts` — extract the result-shaping from `browserFetch` into the exported pure `browserOutcome`, and gather signals in `browserFetch`:

```ts
export function browserOutcome(
  url: string,
  s: PageSignals & { text: string; finalUrl: string; title: string },
): FetchOutcome {
  const reason = detectBlock(s)
  if (reason) {
    return {
      ok: false,
      content: blockNotice(s.finalUrl || url, reason).hint,
      bytes: 0,
      finalUrl: s.finalUrl,
      title: s.title,
    }
  }
  if (s.text.trim().length === 0) {
    let host = url
    try {
      host = new URL(s.finalUrl || url).hostname.replace(/^www\./, '')
    } catch {
      /* keep */
    }
    return {
      ok: false,
      content: `no content extracted from ${host}`,
      bytes: 0,
      finalUrl: s.finalUrl,
      title: s.title,
    }
  }
  return {
    ok: true,
    content: s.text.slice(0, 50000),
    bytes: s.text.length,
    finalUrl: s.finalUrl,
    title: s.title,
  }
}
```

and in `browserFetch`, after the settle wait:

```ts
const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(2000) // Let JS render
const text = await page.innerText('body').catch(() => '')
const html = await page.content().catch(() => '')
return browserOutcome(url, {
  status: response?.status() ?? null,
  text,
  html,
  title: await page.title().catch(() => ''),
  finalUrl: page.url(),
  frameUrls: page.frames().map((f) => f.url()),
})
```

(The `fetch_page` handler already maps `ok: false` to `error: result.content`; `content` is now always a non-empty message.)

`src/routes.ts` — in `/fetch`, change `if (result.error)` to `if (result.error !== undefined)` so an empty error can never read as success.

`src/browse.ts` — `BrowseResult` gains `blocked?: BlockNotice`; `envelope` becomes:

```ts
async function envelope(page: Page): Promise<BrowseResult> {
  const [title, snapshot] = await Promise.all([page.title().catch(() => ''), takeSnapshot(page)])
  const url = page.url()
  let frameUrls: string[] = []
  try {
    frameUrls = page.frames().map((f) => f.url())
  } catch {
    /* page closing */
  }
  const reason = detectBlock({ title, text: snapshot, frameUrls })
  return reason
    ? { url, title, snapshot, blocked: blockNotice(url, reason) }
    : { url, title, snapshot }
}
```

`src/openapi.ts` — add to `browseResultSchema.properties`:

```ts
    blocked: {
      type: 'object',
      description: 'Present when the page is a bot-protection wall.',
      required: ['reason', 'hint'],
      properties: { reason: { type: 'string' }, hint: { type: 'string' } },
    },
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run src/browser-outcome.test.ts src/browse.test.ts src/routes.test.ts && npm run typecheck && npm run lint && npm test`
Expected: PASS; clean; full suite green (existing mock pages without `frames` still work via the try/catch).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tools.ts src/routes.ts src/browse.ts src/openapi.ts src/browse.test.ts src/routes.test.ts src/browser-outcome.test.ts
git add src/tools.ts src/routes.ts src/browse.ts src/openapi.ts src/browse.test.ts src/routes.test.ts src/browser-outcome.test.ts
git commit -m "$(printf 'fix: report bot walls and empty pages as errors, not empty successes\n\nfetch_page returned 200 with empty text when the browser was blocked: the\nhandler copied the empty content into error, and /fetch treated \"\" as no\nerror. Blocks are now detected and named (with a stale-jar hint when the\nsite is in the cookie jar), and browse results carry a blocked field.\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Docs and gated live test

**Files:**

- Create: `src/cookie-jar.integration.test.ts`
- Modify: `package.json` (add `"test:integration:yelp": "YELP_INTEGRATION=1 vitest run src/cookie-jar.integration.test.ts"`), `README.md`

- [ ] **Step 1: Gated live test** (`src/cookie-jar.integration.test.ts`)

Skipped unless `YELP_INTEGRATION=1` and `WEBFETCH_COOKIE_JAR` points at an existing jar. Builds a real `CookieJar` + `BrowserManager` + `createTools`, then:

- `fetch_page` on `https://www.yelp.com/biz/the-french-laundry-yountville` → no `error`, content contains `French Laundry`.
- `fetch_page` on `https://www.yelp.com/search?find_desc=ramen&find_loc=Berkeley%2C+CA` → no `error`, content contains `Ramen`.
- A session (`SessionManager` over the same `BrowserManager`) → `browse.navigate` to the biz page → `blocked` is undefined and the snapshot mentions `French Laundry`.

Tear down with `browserManager.close()` (which flushes the jar). Use a copy of the jar in a temp dir so the test's write-back doesn't touch the user's file.

- [ ] **Step 2: Verify skip, then run live if a jar is available**

Run: `npm test` → integration file present but skipped.
If `/tmp/yelp-cookies.json` exists: `WEBFETCH_COOKIE_JAR=/tmp/yelp-cookies.json npm run test:integration:yelp` → PASS. Otherwise report the skip-verified run and note the live test is pending a jar.

- [ ] **Step 3: README — "Sites behind bot protection" section**

Cover: why (DataDome and similar walls block automation but trust an aged real-browser cookie jar); exporting (`npm run export-cookies -- --domain yelp.com`, run on the desktop where the site works; needs `secret-tool`); copying (the `docker exec` one-liner); hot reload and write-back; `WEBFETCH_COOKIE_JAR`; what a stale-jar error / `blocked` field means (re-export); and that the jar holds live session cookies (mode 600, never logged, keep webfetch LAN-only).

- [ ] **Step 4: Full gate**

Run: `npm run format:check && npm run typecheck && npm run lint && npm test`
Expected: all clean/green.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cookie-jar.integration.test.ts package.json README.md
git add src/cookie-jar.integration.test.ts package.json README.md
git commit -m "$(printf 'docs: cookie-jar workflow; gated live Yelp test\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:** CookieJar (load/hot reload/merge/atomic 600 write/external-wins) → Task 2. BrowserManager integration (inject on create, merge on close, flush on shutdown) → Task 4. Block detection + honest `fetch_page` failures + `blocked` envelope field + OpenAPI → Tasks 1 and 5. Export tool (secret-tool, v10/v11, schema-24 prefix, domain match, merge, mode 600, copy one-liner) → Task 3. Delivery one-liner → printed by Task 3, documented in Task 6. Security (never log values, mode 600, jar-domains-only write-back) → Global Constraints + Tasks 2/3. Testing plan → each task + Task 6.

**Placeholder scan:** Task 6 Step 1 describes the integration test's assertions and setup rather than full code — it is a gated test against a live site whose exact assembly depends on Task 4's constructor; all assertions and fixtures are specified.

**Type consistency:** `BlockReason`/`BlockNotice`/`PageSignals`/`detectBlock`/`blockNotice`/`setJarCoverage` (Task 1) are used unchanged in Tasks 4–5. `CookieJar` methods (Task 2) match the fake in Task 4's test (`inject`/`merge`/`flush`). `browserOutcome`'s signal type extends Task 1's `PageSignals`.
