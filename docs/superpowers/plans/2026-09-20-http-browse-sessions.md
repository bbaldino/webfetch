# HTTP Browse Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose webfetch's interactive browsing (navigate/snapshot/click/type/scroll/back/select/press/wait) over HTTP with an explicit, resource-bounded session lifecycle.

**Architecture:** Extract the per-operation browse logic into one shared `BrowseController` (`src/browse.ts`); both the MCP tools and the new HTTP routes become thin adapters over it. A `SessionManager` enforces a concurrency cap, idle-TTL eviction, and per-session serialization. HTTP routing is extracted from `server.ts` into a testable `router(deps)` in `src/routes.ts`.

**Tech Stack:** TypeScript (TS 7), Node `node:http`, `playwright-core` (Camoufox/Firefox), `vitest`, `oxlint`, `prettier`.

**Spec:** `docs/superpowers/specs/2026-09-20-http-browse-sessions-design.md`

## Global Constraints

- **Node http only** — no web framework; routing is hand-rolled over `node:http`, matching the existing `server.ts`.
- **Prettier config** (`.prettierrc`): `singleQuote: true`, `semi: false`, `printWidth: 100`. Run `npx prettier --write` on changed files before committing.
- **Lint:** `npm run lint` (oxlint, correctness=error) must be clean.
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`, TypeScript 7) must pass.
- **ESM:** relative imports use the `.js` extension (e.g. `import { takeSnapshot } from './snapshot.js'`), as elsewhere in `src/`.
- **Acronym casing:** capitalize only the first letter of multi-letter acronyms (e.g. `Url`, not `URL`) in new identifiers.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Config defaults:** `WEBFETCH_MAX_SESSIONS` = `3`, `WEBFETCH_SESSION_TTL_MS` = `300000`.

## File Structure

- **Create** `src/browse.ts` — `BrowseController`: pure browse ops over a Playwright `Page`, `WaitFor` type, `InvalidRoleError`, moved `VALID_ROLES`.
- **Create** `src/browse.test.ts` — unit tests with a mock `Page`.
- **Create** `src/session-manager.ts` — `SessionManager`: cap/TTL/queue/id over `BrowserManager`; `SessionCapReached`, `SessionNotFound`.
- **Create** `src/session-manager.test.ts` — unit tests with a stub `BrowserManager` + fake timers.
- **Create** `src/routes.ts` — `createRouter(deps)`: the `http` request listener for `/health`, `/fetch`, `/sessions/*`.
- **Create** `src/routes.test.ts` — routing/status-code tests with stub deps.
- **Create** `src/browse-sessions.integration.test.ts` — gated (env `BROWSE_INTEGRATION=1`) real-browser end-to-end.
- **Modify** `src/tools.ts` — `browse_*` handlers delegate to `BrowseController`; delete the local `VALID_ROLES`/`isValidRole` and duplicated op bodies.
- **Modify** `src/server.ts` — bootstrap only: construct singletons + `SessionManager`, hand them to `createRouter`, listen, shutdown.
- **Modify** `package.json` — add `test:integration:browse` script.
- **Modify** `README.md` — document the session endpoints, envelope, `wait_for`, env vars.

---

### Task 1: BrowseController (`src/browse.ts`)

**Files:**

- Create: `src/browse.ts`
- Test: `src/browse.test.ts`

**Interfaces:**

- Consumes: `takeSnapshot(page)` from `./snapshot.js`; `rewriteUrl(url)` from `./url-rewrite.js`.
- Produces:
  - `interface BrowseResult { url: string; title: string; snapshot: string }`
  - `type WaitFor = { role: string; name: string } | { text: string }`
  - `class InvalidRoleError extends Error`
  - `navigate(page, url, opts?: { waitFor?: WaitFor; timeoutMs?: number }): Promise<BrowseResult>`
  - `snapshot(page): Promise<BrowseResult>`
  - `click(page, role: string, name: string): Promise<BrowseResult>`
  - `type(page, role: string, name: string, text: string, submit?: boolean): Promise<BrowseResult>`
  - `scroll(page, direction: 'up' | 'down', amount?: number): Promise<BrowseResult>`
  - `goBack(page): Promise<BrowseResult>`
  - `selectOption(page, role: string, name: string, values: string[]): Promise<BrowseResult>`
  - `pressKey(page, key: string): Promise<BrowseResult>`
  - `waitFor(page, wait: WaitFor, timeoutMs?: number): Promise<BrowseResult>`

- [ ] **Step 1: Write the failing test**

Create `src/browse.test.ts`. The mock `Page` records calls and returns canned values; `takeSnapshot` calls `page.locator(':root').ariaSnapshot()`, so the mock provides that.

```ts
import { describe, it, expect, vi } from 'vitest'
import * as browse from './browse.js'
import { InvalidRoleError } from './browse.js'

function mockPage(overrides: Record<string, unknown> = {}) {
  const locator = {
    first() {
      return this
    },
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    ariaSnapshot: vi.fn(async () => '- document:\n  - heading "Hi"'),
  }
  const page = {
    goto: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    url: () => 'https://example.com/',
    title: async () => 'Example',
    locator: () => locator,
    getByRole: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    mouse: { wheel: vi.fn(async () => {}) },
    keyboard: { press: vi.fn(async () => {}) },
    ...overrides,
  }
  return { page, locator }
}

describe('BrowseController', () => {
  it('navigate rewrites the url, uses domcontentloaded, returns the envelope', async () => {
    const { page } = mockPage()
    const r = await browse.navigate(page as never, 'https://example.com')
    expect(page.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
    expect(r).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      snapshot: '- document:\n  - heading "Hi"',
    })
  })

  it('navigate applies a wait_for condition when given', async () => {
    const { page, locator } = mockPage()
    await browse.navigate(page as never, 'https://example.com', { waitFor: { text: 'Loaded' } })
    expect(page.getByText).toHaveBeenCalledWith('Loaded')
    expect(locator.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'visible' }))
  })

  it('click validates the role and clicks by role+name', async () => {
    const { page, locator } = mockPage()
    await browse.click(page as never, 'button', 'Sign in')
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Sign in' })
    expect(locator.click).toHaveBeenCalled()
  })

  it('click rejects an invalid role', async () => {
    const { page } = mockPage()
    await expect(browse.click(page as never, 'notarole', 'x')).rejects.toBeInstanceOf(
      InvalidRoleError,
    )
  })

  it('type fills and optionally submits', async () => {
    const { page, locator } = mockPage()
    await browse.type(page as never, 'textbox', 'Search', 'hello', true)
    expect(locator.fill).toHaveBeenCalledWith('hello')
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter')
  })

  it('waitFor waits on a role+name locator', async () => {
    const { page, locator } = mockPage()
    await browse.waitFor(page as never, { role: 'button', name: 'Go' }, 1234)
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Go' })
    expect(locator.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 1234 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browse.test.ts`
Expected: FAIL — `browse.js` does not exist / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `src/browse.ts`. Move the `VALID_ROLES` array **verbatim** from `src/tools.ts` (lines ~65–148) into this file.

```ts
import type { Page } from 'playwright-core'
import { takeSnapshot } from './snapshot.js'
import { rewriteUrl } from './url-rewrite.js'

export interface BrowseResult {
  url: string
  title: string
  snapshot: string
}

export type WaitFor = { role: string; name: string } | { text: string }

export class InvalidRoleError extends Error {
  constructor(role: string) {
    super(`Invalid role "${role}". Use a role from the accessibility snapshot.`)
    this.name = 'InvalidRoleError'
  }
}

// Moved verbatim from tools.ts — the ARIA roles Playwright's getByRole accepts.
const VALID_ROLES = [/* ...paste the full list from tools.ts... */] as const
type AriaRole = (typeof VALID_ROLES)[number]

function assertRole(role: string): asserts role is AriaRole {
  if (!VALID_ROLES.includes(role as AriaRole)) throw new InvalidRoleError(role)
}

const DEFAULT_NAV_TIMEOUT = 30000
const DEFAULT_WAIT_TIMEOUT = 15000

async function envelope(page: Page): Promise<BrowseResult> {
  const [title, snapshot] = await Promise.all([page.title().catch(() => ''), takeSnapshot(page)])
  return { url: page.url(), title, snapshot }
}

async function applyWait(
  page: Page,
  wait: WaitFor,
  timeoutMs = DEFAULT_WAIT_TIMEOUT,
): Promise<void> {
  if ('text' in wait) {
    await page.getByText(wait.text).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return
  }
  assertRole(wait.role)
  await page.getByRole(wait.role, { name: wait.name }).first().waitFor({
    state: 'visible',
    timeout: timeoutMs,
  })
}

export async function navigate(
  page: Page,
  url: string,
  opts: { waitFor?: WaitFor; timeoutMs?: number } = {},
): Promise<BrowseResult> {
  await page.goto(rewriteUrl(url), {
    waitUntil: 'domcontentloaded',
    timeout: opts.timeoutMs ?? DEFAULT_NAV_TIMEOUT,
  })
  if (opts.waitFor) await applyWait(page, opts.waitFor, opts.timeoutMs)
  return envelope(page)
}

export async function snapshot(page: Page): Promise<BrowseResult> {
  return envelope(page)
}

export async function click(page: Page, role: string, name: string): Promise<BrowseResult> {
  assertRole(role)
  await page.getByRole(role, { name }).first().click({ timeout: 5000 })
  return envelope(page)
}

export async function type(
  page: Page,
  role: string,
  name: string,
  text: string,
  submit = false,
): Promise<BrowseResult> {
  assertRole(role)
  const el = page.getByRole(role, { name }).first()
  await el.click({ timeout: 5000 })
  await el.fill(text)
  if (submit) await page.keyboard.press('Enter')
  return envelope(page)
}

export async function scroll(
  page: Page,
  direction: 'up' | 'down',
  amount = 500,
): Promise<BrowseResult> {
  await page.mouse.wheel(0, direction === 'down' ? amount : -amount)
  return envelope(page)
}

export async function goBack(page: Page): Promise<BrowseResult> {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
  return envelope(page)
}

export async function selectOption(
  page: Page,
  role: string,
  name: string,
  values: string[],
): Promise<BrowseResult> {
  assertRole(role)
  await page.getByRole(role, { name }).first().selectOption(values)
  return envelope(page)
}

export async function pressKey(page: Page, key: string): Promise<BrowseResult> {
  await page.keyboard.press(key)
  return envelope(page)
}

export async function waitFor(
  page: Page,
  wait: WaitFor,
  timeoutMs?: number,
): Promise<BrowseResult> {
  await applyWait(page, wait, timeoutMs)
  return envelope(page)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/browse.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/browse.ts src/browse.test.ts
git add src/browse.ts src/browse.test.ts
git commit -m "$(printf 'feat: add BrowseController with the shared browse operations\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Delegate the MCP browse tools to BrowseController (`src/tools.ts`)

**Files:**

- Modify: `src/tools.ts` (the `browse_*` tool handlers; remove local `VALID_ROLES`/`isValidRole`)
- Test: none new — verified by `npm run typecheck` + existing suite staying green (no browse-tool unit tests exist today; behavior is covered end-to-end by Task 6).

**Interfaces:**

- Consumes: all exports of `./browse.js` from Task 1.
- Produces: unchanged MCP tool shapes (`browse_navigate` etc. still return `{ url, title, snapshot }` or `{ snapshot }`), so `standalone.ts` is untouched.

- [ ] **Step 1: Import BrowseController and delete the duplicated pieces**

In `src/tools.ts`: add `import * as browse from './browse.js'`. Delete the local `VALID_ROLES` array, the `AriaRole` type, and `isValidRole` (now in `browse.ts`). Delete the local `extractHtmlTitle`/`htmlToText`/`isContentUsable` ONLY if unused after this refactor — otherwise leave them (they are used by `directFetch`/`browserFetch`; keep those).

- [ ] **Step 2: Rewrite each browse\_\* handler to delegate**

Replace the bodies so each resolves the session then calls `browse.*`, translating `InvalidRoleError` to the existing error-return shape. Example for `browse_navigate` and `browse_click`:

```ts
// browse_navigate
async handler(params, ctx) {
  const session = await browserManager.getSession(getRunId(ctx))
  try {
    session.domain = new URL(rewriteUrl(params.url)).hostname
  } catch {
    /* skip */
  }
  const r = await browse.navigate(session.page, params.url)
  return { url: r.url, title: r.title, snapshot: r.snapshot }
},

// browse_click
async handler(params, ctx) {
  const session = await browserManager.getSession(getRunId(ctx))
  try {
    const r = await browse.click(session.page, params.role, params.name)
    return { snapshot: r.snapshot }
  } catch (err) {
    if (err instanceof browse.InvalidRoleError) return { error: err.message }
    throw err
  }
},
```

Apply the same pattern to `browse_snapshot`, `browse_type`, `browse_press_key`, `browse_select_option`, `browse_go_back`, `browse_scroll`. Keep each tool's existing return shape (some return `{ snapshot }`, `browse_navigate`/`browse_go_back` return `{ url, title, snapshot }`).

- [ ] **Step 3: Verify typecheck + lint + existing tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; no unused-symbol lint errors (delete any now-unused imports).

- [ ] **Step 4: Commit**

```bash
npx prettier --write src/tools.ts
git add src/tools.ts
git commit -m "$(printf 'refactor: delegate MCP browse tools to BrowseController\n\nRemoves the duplicated per-op browse logic and role table; the tools\nare now thin adapters over src/browse.ts.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: SessionManager (`src/session-manager.ts`)

**Files:**

- Create: `src/session-manager.ts`
- Test: `src/session-manager.test.ts`

**Interfaces:**

- Consumes: `BrowserManager` (only `getSession(id)` and `closeSession(id)`) from `./browser-manager.js`; `Page` type from `playwright-core`.
- Produces:
  - `class SessionCapReached extends Error`
  - `class SessionNotFound extends Error`
  - `class SessionManager` with:
    - `constructor(bm: BrowserManager, opts: { max: number; ttlMs: number })`
    - `create(): Promise<{ id: string; expiresInMs: number }>` (throws `SessionCapReached`)
    - `run<T>(id: string, fn: (page: Page) => Promise<T>): Promise<T>` (throws `SessionNotFound`; serializes per session; resets TTL after each op)
    - `close(id: string): Promise<void>`
    - `get size(): number`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager, SessionCapReached, SessionNotFound } from './session-manager.js'

function stubBm() {
  return {
    getSession: vi.fn(async (id: string) => ({
      page: { url: () => `about:blank#${id}` },
      context: {},
      domain: undefined,
    })),
    closeSession: vi.fn(async () => {}),
  }
}

describe('SessionManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('creates sessions up to the cap, then throws SessionCapReached', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 2, ttlMs: 1000 })
    await sm.create()
    await sm.create()
    expect(sm.size).toBe(2)
    await expect(sm.create()).rejects.toBeInstanceOf(SessionCapReached)
  })

  it('run throws SessionNotFound for an unknown id', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 2, ttlMs: 1000 })
    await expect(sm.run('nope', async () => 1)).rejects.toBeInstanceOf(SessionNotFound)
  })

  it('evicts a session after the idle TTL and frees a cap slot', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 1, ttlMs: 1000 })
    const { id } = await sm.create()
    await vi.advanceTimersByTimeAsync(1001)
    expect(sm.size).toBe(0)
    expect(bm.closeSession).toHaveBeenCalledWith(id)
    await expect(sm.create()).resolves.toBeTruthy() // slot freed
  })

  it('serializes operations on one session', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 1, ttlMs: 10000 })
    const { id } = await sm.create()
    const order: string[] = []
    const slow = sm.run(id, async () => {
      order.push('start-a')
      await new Promise((r) => setTimeout(r, 50))
      order.push('end-a')
    })
    const fast = sm.run(id, async () => {
      order.push('b')
    })
    await vi.advanceTimersByTimeAsync(60)
    await Promise.all([slow, fast])
    expect(order).toEqual(['start-a', 'end-a', 'b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-manager.test.ts`
Expected: FAIL — `session-manager.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import type { BrowserManager } from './browser-manager.js'

export class SessionCapReached extends Error {
  constructor(max: number) {
    super(`session cap reached (${max})`)
    this.name = 'SessionCapReached'
  }
}

export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`unknown or expired session: ${id}`)
    this.name = 'SessionNotFound'
  }
}

interface Entry {
  timer: ReturnType<typeof setTimeout>
  queue: Promise<unknown>
}

export class SessionManager {
  private entries = new Map<string, Entry>()

  constructor(
    private bm: BrowserManager,
    private opts: { max: number; ttlMs: number },
  ) {}

  get size(): number {
    return this.entries.size
  }

  async create(): Promise<{ id: string; expiresInMs: number }> {
    if (this.entries.size >= this.opts.max) throw new SessionCapReached(this.opts.max)
    const id = randomUUID()
    await this.bm.getSession(id) // eagerly open the context/page
    this.entries.set(id, { timer: this.arm(id), queue: Promise.resolve() })
    return { id, expiresInMs: this.opts.ttlMs }
  }

  async run<T>(id: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const entry = this.entries.get(id)
    if (!entry) throw new SessionNotFound(id)
    const task = entry.queue.then(async () => {
      if (!this.entries.has(id)) throw new SessionNotFound(id) // evicted while queued
      const session = await this.bm.getSession(id)
      try {
        return await fn(session.page)
      } finally {
        this.touch(id)
      }
    })
    entry.queue = task.then(
      () => {},
      () => {},
    )
    return task
  }

  async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.entries.delete(id)
    await this.bm.closeSession(id)
  }

  private touch(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.timer = this.arm(id)
  }

  private arm(id: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      void this.close(id)
    }, this.opts.ttlMs)
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      ;(t as { unref: () => void }).unref()
    }
    return t
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session-manager.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/session-manager.ts src/session-manager.test.ts
git add src/session-manager.ts src/session-manager.test.ts
git commit -m "$(printf 'feat: add SessionManager (cap, idle TTL, per-session serialization)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Extract the HTTP router (`src/routes.ts`) and slim `server.ts`

**Files:**

- Create: `src/routes.ts`
- Create: `src/routes.test.ts`
- Modify: `src/server.ts` (bootstrap only)

**Interfaces:**

- Consumes: `SessionManager` from `./session-manager.js`; the `fetch_page` tool handler.
- Produces:
  - `type FetchPageHandler = (args: { url: string }, ctx: unknown) => Promise<{ url: string; method: string; title?: string; content?: string; error?: string }>`
  - `interface RouterDeps { fetchPage: FetchPageHandler; sessions: SessionManager }`
  - `createRouter(deps: RouterDeps): (req, res) => void` — the `http.createServer` listener; in this task it serves only `/health` and `/fetch` (session routes come in Task 5).

- [ ] **Step 1: Write the failing test**

`src/routes.test.ts` drives `createRouter` with stub deps using Node's `http` against an ephemeral port.

```ts
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createRouter, type RouterDeps } from './routes.js'

let server: http.Server | undefined
afterEach(() => server?.close())

async function start(deps: RouterDeps): Promise<string> {
  server = http.createServer(createRouter(deps))
  await new Promise<void>((r) => server!.listen(0, r))
  const { port } = server!.address() as import('node:net').AddressInfo
  return `http://127.0.0.1:${port}`
}

const stubDeps = (): RouterDeps => ({
  fetchPage: async ({ url }) => ({ url, method: 'stub', title: 'T', content: 'C' }),
  sessions: {} as never,
})

describe('createRouter', () => {
  it('GET /health returns ok', async () => {
    const base = await start(stubDeps())
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('POST /fetch returns the tool result', async () => {
    const base = await start(stubDeps())
    const res = await fetch(`${base}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.test' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ title: 'T', text: 'C', method: 'stub' })
  })

  it('unknown route returns 404 with a hint', async () => {
    const base = await start(stubDeps())
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
    expect((await res.json()).hint).toContain('/fetch')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes.test.ts`
Expected: FAIL — `routes.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/routes.ts` by moving the `readBody`, `json`, and request-handling logic out of `server.ts` (keep the current `/health` + `/fetch` behavior, including the 404 hint added earlier).

```ts
import type http from 'node:http'
import type { SessionManager } from './session-manager.js'

export type FetchPageHandler = (
  args: { url: string },
  ctx: unknown,
) => Promise<{ url: string; method: string; title?: string; content?: string; error?: string }>

export interface RouterDeps {
  fetchPage: FetchPageHandler
  sessions: SessionManager
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createRouter(deps: RouterDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'GET' && pathname === '/health') {
        json(res, 200, { status: 'ok' })
        return
      }

      if (req.method === 'POST' && pathname === '/fetch') {
        const raw = await readBody(req)
        let url: unknown
        try {
          url = (JSON.parse(raw || '{}') as { url?: unknown }).url
        } catch {
          json(res, 400, { error: 'invalid JSON body' })
          return
        }
        if (typeof url !== 'string' || url.length === 0) {
          json(res, 400, { error: 'a "url" string is required' })
          return
        }
        const ctx = { credentials: {}, fetch: globalThis.fetch }
        const result = await deps.fetchPage({ url }, ctx)
        if (result.error) {
          json(res, 502, { error: result.error, final_url: result.url })
          return
        }
        json(res, 200, {
          title: result.title ?? '',
          text: result.content ?? '',
          final_url: result.url,
          method: result.method,
        })
        return
      }

      json(res, 404, {
        error: 'not found',
        hint: 'POST /fetch with JSON {"url":"..."}, or GET /health',
      })
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
    }
  }
}
```

Then rewrite `src/server.ts` to a bootstrap that constructs the singletons and hands them to `createRouter`:

```ts
import http from 'node:http'
import Database from 'better-sqlite3'
import { runMigrations } from './core-compat.js'
import { BrowserManager } from './browser-manager.js'
import { DomainDb } from './domain-db.js'
import { createTools } from './tools.js'
import { SessionManager } from './session-manager.js'
import { createRouter } from './routes.js'

const port = Number(process.env.PORT ?? 9000)
const headless = process.env.WEBFETCH_HEADLESS !== 'false'
const maxSessions = Number(process.env.WEBFETCH_MAX_SESSIONS ?? 3)
const sessionTtlMs = Number(process.env.WEBFETCH_SESSION_TTL_MS ?? 300000)

const browserManager = new BrowserManager({ headless })
const db = new Database(process.env.WEBFETCH_DB ?? ':memory:')
runMigrations(db, import.meta.url)
const domainDb = new DomainDb({ raw: db })

const tools = createTools(browserManager, domainDb)
const fetchPage = tools.find((t) => t.name === 'fetch_page')
if (!fetchPage) throw new Error('fetch_page tool not found')

const sessions = new SessionManager(browserManager, { max: maxSessions, ttlMs: sessionTtlMs })

const server = http.createServer(
  createRouter({
    fetchPage: (args, ctx) => fetchPage.handler(args, ctx as never) as never,
    sessions,
  }),
)

async function shutdown(): Promise<void> {
  server.close()
  try {
    await browserManager.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(port, () => {
  console.error(`webfetch server listening on :${port}`)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/routes.test.ts && npm run typecheck && npm test`
Expected: PASS; typecheck clean; full suite green.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/routes.ts src/routes.test.ts src/server.ts
git add src/routes.ts src/routes.test.ts src/server.ts
git commit -m "$(printf 'refactor: extract a testable HTTP router from server.ts\n\nMoves request handling into createRouter(deps) so routes can be unit\ntested without constructing a browser; server.ts is now bootstrap only.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Session routes (`src/routes.ts`)

**Files:**

- Modify: `src/routes.ts` (add `/sessions` handling)
- Modify: `src/routes.test.ts` (add session-route tests)

**Interfaces:**

- Consumes: `SessionManager` (`create`/`run`/`close`), `BrowseController` (`* from ./browse.js`), and its `InvalidRoleError`.
- Produces: the `/sessions` REST endpoints per the spec, mapping typed errors to `400/404/429/502`.

- [ ] **Step 1: Write the failing test**

Add to `src/routes.test.ts` a stub `SessionManager` that records calls and can simulate cap/not-found. (`run(id, fn)` invokes `fn` with a mock page so `browse.*` returns an envelope.)

```ts
import * as browse from './browse.js'
import { SessionCapReached, SessionNotFound } from './session-manager.js'

function sessionStub() {
  const mockPage = {
    goto: async () => {},
    url: () => 'https://example.com/',
    title: async () => 'Example',
    locator: () => ({ ariaSnapshot: async () => '- document' }),
    getByRole: () => ({ first: () => ({ click: async () => {}, fill: async () => {} }) }),
  }
  return {
    created: [] as string[],
    async create() {
      this.created.push('x')
      if (this.created.length > 1) throw new SessionCapReached(1)
      return { id: 'sess-1', expiresInMs: 300000 }
    },
    async run(id: string, fn: (p: unknown) => Promise<unknown>) {
      if (id !== 'sess-1') throw new SessionNotFound(id)
      return fn(mockPage)
    },
    async close() {},
    size: 0,
  }
}

describe('session routes', () => {
  it('POST /sessions returns 201 + id', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions`, { method: 'POST' })
    expect(res.status).toBe(201)
    expect((await res.json()).session_id).toBe('sess-1')
  })

  it('POST /sessions returns 429 at cap', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    await fetch(`${base}/sessions`, { method: 'POST' })
    const res = await fetch(`${base}/sessions`, { method: 'POST' })
    expect(res.status).toBe(429)
  })

  it('navigate on an unknown session returns 404', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/ghost/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.test' }),
    })
    expect(res.status).toBe(404)
  })

  it('navigate returns the envelope', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ url: 'https://example.com/', title: 'Example' })
  })

  it('missing url on navigate returns 400', async () => {
    const sessions = sessionStub()
    const base = await start({
      fetchPage: async () => ({ url: '', method: '' }),
      sessions,
    } as never)
    const res = await fetch(`${base}/sessions/sess-1/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes.test.ts`
Expected: FAIL — session routes return 404 (not yet implemented).

- [ ] **Step 3: Write minimal implementation**

In `src/routes.ts`, add `import * as browse from './browse.js'` and the session-manager error imports, then handle `/sessions` before the final 404. Insert into `createRouter`'s handler:

```ts
// --- sessions ---
if (pathname === '/sessions' && req.method === 'POST') {
  try {
    const { id, expiresInMs } = await deps.sessions.create()
    json(res, 201, { session_id: id, expires_in_ms: expiresInMs })
  } catch (err) {
    mapError(res, err)
  }
  return
}

const m = pathname.match(/^\/sessions\/([^/]+)(?:\/([^/]+))?$/)
if (m) {
  const id = decodeURIComponent(m[1])
  const op = m[2]
  if (req.method === 'DELETE' && !op) {
    await deps.sessions.close(id)
    res.writeHead(204).end()
    return
  }
  if (req.method === 'POST' && op) {
    const raw = await readBody(req)
    let body: Record<string, unknown>
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      json(res, 400, { error: 'invalid JSON body' })
      return
    }
    try {
      const result = await runOp(deps.sessions, id, op, body)
      json(res, 200, result)
    } catch (err) {
      mapError(res, err)
    }
    return
  }
}
```

Add these helpers to `routes.ts`:

```ts
function need(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || v.length === 0) throw new BadRequest(`"${key}" string is required`)
  return v
}

class BadRequest extends Error {}

async function runOp(
  sessions: SessionManager,
  id: string,
  op: string,
  body: Record<string, unknown>,
): Promise<browse.BrowseResult> {
  switch (op) {
    case 'navigate':
      return sessions.run(id, (p) =>
        browse.navigate(p, need(body, 'url'), {
          waitFor: body.wait_for as browse.WaitFor | undefined,
          timeoutMs: body.timeout_ms as number | undefined,
        }),
      )
    case 'snapshot':
      return sessions.run(id, (p) => browse.snapshot(p))
    case 'click':
      return sessions.run(id, (p) => browse.click(p, need(body, 'role'), need(body, 'name')))
    case 'type':
      return sessions.run(id, (p) =>
        browse.type(
          p,
          need(body, 'role'),
          need(body, 'name'),
          need(body, 'text'),
          body.submit === true,
        ),
      )
    case 'scroll':
      return sessions.run(id, (p) =>
        browse.scroll(
          p,
          body.direction === 'up' ? 'up' : 'down',
          body.amount as number | undefined,
        ),
      )
    case 'back':
      return sessions.run(id, (p) => browse.goBack(p))
    case 'select':
      return sessions.run(id, (p) =>
        browse.selectOption(
          p,
          need(body, 'role'),
          need(body, 'name'),
          (body.values as string[]) ?? [],
        ),
      )
    case 'press':
      return sessions.run(id, (p) => browse.pressKey(p, need(body, 'key')))
    case 'wait':
      return sessions.run(id, (p) =>
        browse.waitFor(p, body.wait_for as browse.WaitFor, body.timeout_ms as number | undefined),
      )
    default:
      throw new BadRequest(`unknown operation "${op}"`)
  }
}

function mapError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof SessionCapReached) {
    json(res, 429, { error: err.message, hint: 'close a session or retry' })
  } else if (err instanceof SessionNotFound) {
    json(res, 404, { error: err.message, hint: 'create a new session' })
  } else if (err instanceof browse.InvalidRoleError || err instanceof BadRequest) {
    json(res, 400, { error: (err as Error).message })
  } else {
    json(res, 502, { error: (err as Error).message })
  }
}
```

Add the imports at the top of `routes.ts`:

```ts
import * as browse from './browse.js'
import { SessionCapReached, SessionNotFound, type SessionManager } from './session-manager.js'
```

(Replace the existing `type { SessionManager }` import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/routes.test.ts && npm run typecheck && npm run lint`
Expected: PASS; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/routes.ts src/routes.test.ts
git add src/routes.ts src/routes.test.ts
git commit -m "$(printf 'feat: add HTTP session routes for interactive browsing\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Gated integration test + docs

**Files:**

- Create: `src/browse-sessions.integration.test.ts`
- Modify: `package.json` (add `test:integration:browse` script)
- Modify: `README.md`

**Interfaces:**

- Consumes: `BrowserManager`, `SessionManager`, `createRouter` — a full in-process server against a real Camoufox.

- [ ] **Step 1: Write the gated integration test**

```ts
// Real-browser end-to-end for the session API. Skipped in `npm test`; runs only
// with BROWSE_INTEGRATION=1 (needs the Camoufox browser downloaded).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { BrowserManager } from './browser-manager.js'
import { SessionManager } from './session-manager.js'
import { createRouter } from './routes.js'

const RUN = process.env.BROWSE_INTEGRATION === '1'
let server: http.Server
let bm: BrowserManager
let base: string

beforeAll(async () => {
  if (!RUN) return
  bm = new BrowserManager({ headless: true })
  const sessions = new SessionManager(bm, { max: 2, ttlMs: 60000 })
  server = http.createServer(
    createRouter({ fetchPage: async () => ({ url: '', method: '' }), sessions }),
  )
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as import('node:net').AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  if (!RUN) return
  server.close()
  await bm.close()
})

describe.skipIf(!RUN)('session API (live browser)', () => {
  it('creates a session, navigates, snapshots, clicks, and closes', async () => {
    const created = await (await fetch(`${base}/sessions`, { method: 'POST' })).json()
    const id = created.session_id
    expect(id).toBeTruthy()

    const nav = await (
      await fetch(`${base}/sessions/${id}/navigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      })
    ).json()
    expect(nav.snapshot).toContain('Example Domain')

    const clicked = await fetch(`${base}/sessions/${id}/click`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'link', name: 'More information...' }),
    })
    expect([200, 502]).toContain(clicked.status) // link name may vary; assert it routed

    const del = await fetch(`${base}/sessions/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
  }, 60000)
})
```

- [ ] **Step 2: Add the script and verify skip behavior**

In `package.json` `scripts`, add:

```json
"test:integration:browse": "BROWSE_INTEGRATION=1 vitest run src/browse-sessions.integration.test.ts"
```

Run: `npm test`
Expected: the new file is present but **skipped** (no `BROWSE_INTEGRATION`), suite still green.

- [ ] **Step 3: Run the integration test (browser must be downloaded)**

Run: `npm run test:integration:browse`
Expected: PASS (creates session, navigate snapshot contains "Example Domain", delete → 204). If the "More information..." link name differs, the click still routes (200 or 502) — adjust the `name` to match `example.com`'s current link text if needed.

- [ ] **Step 4: Document in README**

Add a section under the REST description covering the session endpoints, the `{url,title,snapshot}` envelope, the `wait_for` shape (`{role,name}` | `{text}`), and the env vars `WEBFETCH_MAX_SESSIONS` (default 3) and `WEBFETCH_SESSION_TTL_MS` (default 300000). Mention sessions are in-memory (a `404` means "recreate").

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/browse-sessions.integration.test.ts package.json README.md
git add src/browse-sessions.integration.test.ts package.json README.md
git commit -m "$(printf 'test: add gated live-browser integration test; document session API\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**

- API surface (all 11 endpoints + envelope) → Tasks 4 (health/fetch) + 5 (sessions).
- Session lifecycle/limits (cap→429, idle TTL, per-session serialization, unknown→404) → Task 3, exercised in Task 5.
- BrowseController + `wait_for` → Task 1.
- Both faces adapt (tools delegate) → Task 2.
- Error mapping table → Task 5 (`mapError`).
- Module layout / `server.ts` router extraction → Task 4.
- Config env vars → Task 4 bootstrap (read) + Task 6 (documented).
- Testing strategy (unit browse, unit session-manager, routing, gated integration) → Tasks 1/3/4/5/6.

**Placeholder scan:** the only intentional "paste from source" is the `VALID_ROLES` list in Task 1 (an ~85-entry verbatim move from `tools.ts`; re-typing it here is noise) — the step names the exact source lines.

**Type consistency:** `BrowseResult`/`WaitFor`/`InvalidRoleError` (Task 1) are consumed unchanged in Tasks 2 and 5; `SessionManager.create/run/close/size` and `SessionCapReached`/`SessionNotFound` (Task 3) are consumed unchanged in Tasks 5 and 6; `RouterDeps`/`FetchPageHandler` (Task 4) are used unchanged in Tasks 5 and 6.
