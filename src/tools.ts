import { z } from 'zod'
import { defineTool, type ToolDeclaration } from './core-compat.js'
import type { BrowserManager } from './browser-manager.js'
import type { DomainDb } from './domain-db.js'
import { takeSnapshot } from './snapshot.js'
import { isRedditUrl, fetchReddit } from './reddit.js'
import { rewriteUrl } from './url-rewrite.js'

/**
 * Extract a run ID from the tool context.
 */
function getRunId(ctx: { agentName?: string; channelId?: string }): string {
  return `${ctx.agentName ?? 'unknown'}:${ctx.channelId ?? 'default'}`
}

function extractDomain(url: string): string | null {
  try {
    const hostname = new URL(url).hostname
    return hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Strip HTML to plain text.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Heuristic: is the fetched HTML content likely usable?
 * Returns false if it looks like a JS-only page, captcha wall, etc.
 */
function isContentUsable(text: string): boolean {
  // Very short content after stripping tags is suspicious
  if (text.length < 200) return false
  // Common indicators of blocked/JS-required pages
  const blockedPatterns = [
    'enable javascript',
    'please enable cookies',
    'access denied',
    'just a moment',
    'checking your browser',
    'cloudflare',
    'captcha',
    'you need to enable javascript',
  ]
  const lower = text.toLowerCase()
  for (const pattern of blockedPatterns) {
    if (lower.includes(pattern) && text.length < 2000) return true // Only flag if page is mostly just this
  }
  return true
}

/**
 * Valid ARIA roles for getByRole().
 */
const VALID_ROLES = [
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
] as const

type AriaRole = (typeof VALID_ROLES)[number]

function isValidRole(role: string): role is AriaRole {
  return VALID_ROLES.includes(role as AriaRole)
}

/** Extract the page <title>, if any. */
function extractHtmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? m[1].trim() : ''
}

interface FetchOutcome {
  ok: boolean
  content: string
  bytes: number
  finalUrl: string
  title: string
}

/**
 * Direct HTTP fetch of a URL.
 */
async function directFetch(url: string): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.109 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      return {
        ok: false,
        content: `HTTP ${response.status}: ${response.statusText}`,
        bytes: 0,
        finalUrl: url,
        title: '',
      }
    }

    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const isHtml = contentType.includes('html')
    const content = isHtml ? htmlToText(text) : text

    return {
      ok: true,
      content: content.slice(0, 50000),
      bytes: text.length,
      finalUrl: response.url,
      title: isHtml ? extractHtmlTitle(text) : '',
    }
  } catch (err) {
    return {
      ok: false,
      content: `Fetch error: ${(err as Error).message}`,
      bytes: 0,
      finalUrl: url,
      title: '',
    }
  }
}

/**
 * Browser-based fetch of a URL.
 */
async function browserFetch(url: string, browserManager: BrowserManager): Promise<FetchOutcome> {
  let context: { close(): Promise<void> } | undefined
  try {
    const temp = await browserManager.createTempPage()
    context = temp.context
    const page = temp.page
    url = rewriteUrl(url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(2000) // Let JS render
    const text = await page.innerText('body').catch(() => '')
    const finalUrl = page.url()
    const title = await page.title().catch(() => '')
    return {
      ok: text.length > 0,
      content: text.slice(0, 50000),
      bytes: text.length,
      finalUrl,
      title,
    }
  } catch (err) {
    return {
      ok: false,
      content: `Browser error: ${(err as Error).message}`,
      bytes: 0,
      finalUrl: url,
      title: '',
    }
  } finally {
    if (context) await context.close().catch(() => {})
  }
}

export function createTools(browserManager: BrowserManager, domainDb: DomainDb): ToolDeclaration[] {
  return [
    defineTool({
      name: 'fetch_page',
      description:
        'Fetch a web page and return its text content. Automatically chooses the best method ' +
        '(direct HTTP or browser) based on domain history. For interactive browsing (clicking, ' +
        'filling forms), use browse_navigate instead.',
      params: z.object({
        url: z.string().describe('The URL to fetch'),
      }),
      async handler(params) {
        const domain = extractDomain(params.url)

        // Reddit-aware routing: bypass the fetch/browser path entirely.
        // Reddit blocks default UAs but accepts .json+Chrome UA, old.reddit,
        // and FeedFetcher-Google UA. See reddit.ts for the chain.
        if (isRedditUrl(params.url)) {
          const r = await fetchReddit(params.url)
          if (domain) {
            if (r.ok) domainDb.recordSuccess(domain, 'fetch', r.bytes)
            else domainDb.recordFailure(domain, 'fetch')
          }
          return {
            url: r.finalUrl,
            method: r.method,
            title: r.title ?? '',
            content: r.ok ? r.content : (r.error ?? 'Reddit fetch failed'),
            ...(r.ok ? {} : { error: r.error ?? 'Reddit fetch failed' }),
          }
        }

        const preferredMethod = domain ? domainDb.getPreferredMethod(domain) : 'auto'

        // If domain is configured for browser-only, skip fetch
        if (preferredMethod === 'browser') {
          const result = await browserFetch(params.url, browserManager)
          if (domain) {
            if (result.ok) {
              domainDb.recordSuccess(domain, 'browser', result.bytes)
            } else {
              domainDb.recordFailure(domain, 'browser')
            }
          }
          return {
            url: result.finalUrl,
            method: 'browser',
            title: result.title,
            content: result.content,
            ...(result.ok ? {} : { error: result.content }),
          }
        }

        // Try direct fetch first
        const fetchResult = await directFetch(params.url)

        if (fetchResult.ok && isContentUsable(fetchResult.content)) {
          if (domain) domainDb.recordSuccess(domain, 'fetch', fetchResult.bytes)
          return {
            url: fetchResult.finalUrl,
            method: 'fetch',
            title: fetchResult.title,
            content: fetchResult.content,
          }
        }

        // Fetch failed or content looks unusable — fall back to browser
        if (domain) domainDb.recordFailure(domain, 'fetch')

        const browserResult = await browserFetch(params.url, browserManager)
        if (domain) {
          if (browserResult.ok) {
            domainDb.recordSuccess(domain, 'browser', browserResult.bytes)
          } else {
            domainDb.recordFailure(domain, 'browser')
          }
        }

        return {
          url: browserResult.finalUrl,
          method: 'browser (fallback)',
          title: browserResult.title,
          content: browserResult.content,
          ...(browserResult.ok ? {} : { error: browserResult.content }),
        }
      },
    }),

    defineTool({
      name: 'browse_navigate',
      description:
        'Navigate to a URL in the browser and return an accessibility snapshot of the page. ' +
        'Use this when you need to interact with a page (click, fill forms) or when fetch_page ' +
        'fails for JavaScript-heavy sites. The snapshot shows interactive elements with their ' +
        'role and name — use these to identify elements for browse_click and browse_type.',
      params: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
      async handler(params, ctx) {
        const session = await browserManager.getSession(getRunId(ctx))
        const url = rewriteUrl(params.url)
        await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await session.page.waitForTimeout(1000)
        try {
          session.domain = new URL(url).hostname
        } catch {
          /* skip */
        }
        const snapshot = await takeSnapshot(session.page)
        return {
          url: session.page.url(),
          title: await session.page.title(),
          snapshot,
        }
      },
    }),

    defineTool({
      name: 'browse_snapshot',
      description:
        'Take an accessibility snapshot of the current browser page. Returns the page structure ' +
        'showing interactive elements with their role and name.',
      params: z.object({}),
      async handler(_params, ctx) {
        const session = await browserManager.getSession(getRunId(ctx))
        const snapshot = await takeSnapshot(session.page)
        return {
          url: session.page.url(),
          title: await session.page.title(),
          snapshot,
        }
      },
    }),

    defineTool({
      name: 'browse_click',
      description:
        'Click an interactive element on the page. Specify the element by its ARIA role and name ' +
        'from the accessibility snapshot (e.g., role: "link", name: "About Us").',
      params: z.object({
        role: z.string().describe('ARIA role of the element (e.g., "button", "link", "textbox")'),
        name: z.string().describe('Accessible name of the element'),
      }),
      async handler(params, ctx) {
        if (!isValidRole(params.role)) {
          return {
            error: `Invalid role "${params.role}". Use a role from the accessibility snapshot.`,
          }
        }
        const session = await browserManager.getSession(getRunId(ctx))
        await session.page
          .getByRole(params.role, { name: params.name })
          .first()
          .click({ timeout: 5000 })
        await session.page.waitForTimeout(500)
        const snapshot = await takeSnapshot(session.page)
        return { snapshot }
      },
    }),

    defineTool({
      name: 'browse_type',
      description:
        'Type text into a form field. Specify the element by its ARIA role and name. ' +
        'Optionally submit by pressing Enter after typing.',
      params: z.object({
        role: z.string().describe('ARIA role (usually "textbox", "searchbox", or "combobox")'),
        name: z
          .string()
          .describe('Accessible name of the element (e.g., placeholder text or label)'),
        text: z.string().describe('The text to type'),
        submit: z.boolean().optional().describe('Press Enter after typing (default: false)'),
      }),
      async handler(params, ctx) {
        if (!isValidRole(params.role)) {
          return { error: `Invalid role "${params.role}".` }
        }
        const session = await browserManager.getSession(getRunId(ctx))
        const el = session.page.getByRole(params.role, { name: params.name }).first()
        await el.click({ timeout: 5000 })
        await el.fill(params.text)
        if (params.submit) {
          await session.page.keyboard.press('Enter')
          await session.page.waitForTimeout(1000)
        }
        const snapshot = await takeSnapshot(session.page)
        return { snapshot }
      },
    }),

    defineTool({
      name: 'browse_press_key',
      description: 'Press a keyboard key (e.g., "Enter", "Escape", "Tab", "ArrowDown").',
      params: z.object({
        key: z.string().describe('The key to press'),
      }),
      async handler(params, ctx) {
        const session = await browserManager.getSession(getRunId(ctx))
        await session.page.keyboard.press(params.key)
        await session.page.waitForTimeout(300)
        const snapshot = await takeSnapshot(session.page)
        return { snapshot }
      },
    }),

    defineTool({
      name: 'browse_select_option',
      description: 'Select an option from a dropdown/select element.',
      params: z.object({
        role: z.string().describe('ARIA role of the select element'),
        name: z.string().describe('Accessible name of the select element'),
        values: z.array(z.string()).describe('Values to select'),
      }),
      async handler(params, ctx) {
        if (!isValidRole(params.role)) {
          return { error: `Invalid role "${params.role}".` }
        }
        const session = await browserManager.getSession(getRunId(ctx))
        const el = session.page.getByRole(params.role, { name: params.name }).first()
        await el.selectOption(params.values)
        const snapshot = await takeSnapshot(session.page)
        return { snapshot }
      },
    }),

    defineTool({
      name: 'browse_go_back',
      description: 'Navigate back to the previous page.',
      params: z.object({}),
      async handler(_params, ctx) {
        const session = await browserManager.getSession(getRunId(ctx))
        await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
        await session.page.waitForTimeout(500)
        const snapshot = await takeSnapshot(session.page)
        return {
          url: session.page.url(),
          title: await session.page.title(),
          snapshot,
        }
      },
    }),

    defineTool({
      name: 'browse_scroll',
      description: 'Scroll the page up or down.',
      params: z.object({
        direction: z.enum(['up', 'down']).describe('Scroll direction'),
        amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
      }),
      async handler(params, ctx) {
        const session = await browserManager.getSession(getRunId(ctx))
        const pixels = params.amount ?? 500
        const delta = params.direction === 'down' ? pixels : -pixels
        await session.page.mouse.wheel(0, delta)
        await session.page.waitForTimeout(300)
        const snapshot = await takeSnapshot(session.page)
        return { snapshot }
      },
    }),
  ]
}
