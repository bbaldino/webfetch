import { firefox, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { launchOptions } from 'camoufox-js'

export interface BrowserSession {
  context: BrowserContext
  page: Page
  domain: string | undefined
}

export class BrowserManager {
  private browser: Browser | null = null
  private sessions = new Map<string, BrowserSession>()
  private headless: boolean

  constructor(opts: { headless?: boolean } = {}) {
    this.headless = opts.headless ?? true
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
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

  /**
   * Get or create a browser session for an agent run.
   * Each agent run gets its own BrowserContext for isolation.
   */
  async getSession(runId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(runId)
    if (existing && !existing.page.isClosed()) {
      return existing
    }

    const browser = await this.ensureBrowser()
    const context = await browser.newContext()
    const page = await context.newPage()
    const session: BrowserSession = { context, page, domain: undefined }
    this.sessions.set(runId, session)
    return session
  }

  /**
   * Create a temporary page for a one-shot fetch (not tied to a run).
   * Caller is responsible for closing the page and context.
   */
  async createTempPage(): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await this.ensureBrowser()
    const context = await browser.newContext()
    const page = await context.newPage()
    return { context, page }
  }

  /**
   * Clean up a session when an agent run completes.
   */
  async closeSession(runId: string): Promise<void> {
    const session = this.sessions.get(runId)
    if (session) {
      this.sessions.delete(runId)
      try {
        await session.context.close()
      } catch {
        // Context may already be closed
      }
    }
  }

  /**
   * Shut down the browser entirely.
   */
  async close(): Promise<void> {
    for (const [runId] of this.sessions) {
      await this.closeSession(runId)
    }
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
