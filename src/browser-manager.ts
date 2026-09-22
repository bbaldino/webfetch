import { firefox, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { launchOptions } from 'camoufox-js'
import type { CookieJar, CookieSeed } from './cookie-jar.js'

export interface BrowserSession {
  context: BrowserContext
  page: Page
  domain: string | undefined
}

export class BrowserManager {
  private browser: Browser | null = null
  private sessions = new Map<string, BrowserSession>()
  private tempContexts = new Set<BrowserContext>()
  // What each context was seeded with, so closeContext writes back only what it changed.
  private seeds = new WeakMap<BrowserContext, CookieSeed>()
  private headless: boolean
  private jar: CookieJar | undefined
  private launchFn: (() => Promise<Browser>) | undefined
  private closePromise: Promise<void> | undefined

  constructor(opts: { headless?: boolean; jar?: CookieJar; launch?: () => Promise<Browser> } = {}) {
    this.headless = opts.headless ?? true
    this.jar = opts.jar
    this.launchFn = opts.launch
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser
    }
    if (this.launchFn) {
      this.browser = await this.launchFn()
      return this.browser
    }
    // Camoufox (a Firefox fork) spoofs the fingerprint — navigator, WebGL,
    // AudioContext, screen geometry, WebRTC — at the C++ level, before any JS
    // runs. That replaces the JS `addInitScript` stealth shims we needed with
    // Chromium (which modern anti-bot systems can detect as tells). The
    // fingerprint is set here at launch and inherited by every context, so
    // contexts are created plain — a per-context userAgent override would fight
    // it and reintroduce an inconsistency.
    const options = await launchOptions({
      headless: this.headless,
      os: 'linux',
      locale: 'en-US',
      humanize: true, // subtle cursor humanization
      enable_cache: true, // warm HTTP cache across navigations within a session
    })
    // Let our own shutdown (onShutdown → close()) be the sole authority; don't let
    // Playwright's signal handlers race ahead and kill the browser mid-cleanup.
    options.handleSIGTERM = false
    options.handleSIGINT = false
    options.handleSIGHUP = false
    this.browser = await firefox.launch(options)
    return this.browser
  }

  private async newContext(): Promise<BrowserContext> {
    const browser = await this.ensureBrowser()
    const context = await browser.newContext()
    // Seed every context with the cookie jar so bot-protected sites see a trusted visitor.
    if (this.jar) {
      try {
        this.seeds.set(context, await this.jar.inject(context))
      } catch (err) {
        console.error(`cookie jar inject failed: ${(err as Error).message}`)
      }
    }
    return context
  }

  /** Close a context, first writing any cookies the sites rotated back to the jar. */
  async closeContext(context: BrowserContext): Promise<void> {
    this.tempContexts.delete(context)
    if (this.jar) {
      try {
        const seed = this.seeds.get(context) ?? new Map()
        this.jar.mergeChanged(seed, await context.cookies())
      } catch {
        /* best-effort: never fail a close over write-back */
      }
    }
    await context.close().catch(() => {})
  }

  /**
   * Get or create a browser session for an agent run.
   * Each agent run gets its own BrowserContext for isolation.
   */
  async getSession(runId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(runId)
    if (existing) {
      if (!existing.page.isClosed()) {
        return existing
      }
      // The caller closed the page out from under us (e.g. page.close() in a
      // script). Merge and close the old context before replacing it, or its
      // rotated cookies never reach the jar.
      await this.closeContext(existing.context)
    }

    const context = await this.newContext()
    let page: Page
    try {
      page = await context.newPage()
    } catch (err) {
      // Nothing worth merging yet — just close the context we just opened.
      await context.close().catch(() => {})
      throw err
    }
    const session: BrowserSession = { context, page, domain: undefined }
    this.sessions.set(runId, session)
    return session
  }

  /**
   * Create a temporary page for a one-shot fetch (not tied to a run).
   * Caller is responsible for closing the page and context.
   */
  async createTempPage(): Promise<{ context: BrowserContext; page: Page }> {
    const context = await this.newContext()
    let page: Page
    try {
      page = await context.newPage()
    } catch (err) {
      await context.close().catch(() => {})
      throw err
    }
    this.tempContexts.add(context)
    return { context, page }
  }

  /**
   * Clean up a session when an agent run completes.
   */
  async closeSession(runId: string): Promise<void> {
    const session = this.sessions.get(runId)
    if (session) {
      this.sessions.delete(runId)
      await this.closeContext(session.context)
    }
  }

  /**
   * Shut down the browser entirely. Idempotent — a second call awaits the
   * same in-flight (or settled) shutdown rather than racing it.
   */
  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.doClose()
    }
    return this.closePromise
  }

  private async doClose(): Promise<void> {
    for (const [runId] of this.sessions) {
      await this.closeSession(runId)
    }
    // Temp-page contexts still in flight (e.g. a fetch mid-navigation) also
    // get their write-back merged before we flush and kill the browser.
    for (const context of this.tempContexts) {
      await this.closeContext(context)
    }
    await this.jar?.flush()
    if (this.browser) {
      try {
        await this.browser.close()
      } catch {
        // Browser may already be closed
      }
      this.browser = null
    }
  }
}
