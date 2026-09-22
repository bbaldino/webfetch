// Gated live end-to-end against Yelp's real DataDome wall — proof the cookie jar actually
// gets a headless Camoufox browser past it. Skipped in `npm test`; runs only with
// YELP_INTEGRATION=1 and WEBFETCH_COOKIE_JAR pointing at an existing jar (needs the
// Camoufox browser downloaded). The source jar is copied into a temp file (mode 600) and
// the CookieJar under test points at the copy, so this test's write-back never touches
// the user's real jar.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations, type ToolContext, type ToolDeclaration } from './core-compat.js'
import { BrowserManager } from './browser-manager.js'
import { CookieJar } from './cookie-jar.js'
import { DomainDb } from './domain-db.js'
import { createTools } from './tools.js'
import { SessionManager } from './session-manager.js'
import * as browse from './browse.js'

const sourceJar = process.env.WEBFETCH_COOKIE_JAR
const RUN = process.env.YELP_INTEGRATION === '1' && !!sourceJar && existsSync(sourceJar)

const BIZ_URL = 'https://www.yelp.com/biz/the-french-laundry-yountville'
const SEARCH_URL = 'https://www.yelp.com/search?find_desc=ramen&find_loc=Berkeley%2C+CA'

let bm: BrowserManager
let fetchPage: ToolDeclaration
let sessions: SessionManager

beforeAll(async () => {
  if (!RUN) return

  // Copy the jar so merge()'s write-back on context close lands in the temp dir, never
  // in the user's real jar file.
  const dir = mkdtempSync(join(tmpdir(), 'webfetch-yelp-jar-'))
  const jarCopyPath = join(dir, 'cookies.json')
  copyFileSync(sourceJar as string, jarCopyPath)
  chmodSync(jarCopyPath, 0o600)
  const jar = new CookieJar(jarCopyPath)

  bm = new BrowserManager({ headless: true, jar })
  const db = new Database(':memory:')
  runMigrations(db, import.meta.url)
  const domainDb = new DomainDb({ raw: db })

  const tools = createTools(bm, domainDb)
  const found = tools.find((t) => t.name === 'fetch_page')
  if (!found) throw new Error('fetch_page tool not found')
  fetchPage = found

  sessions = new SessionManager(bm, { max: 2, ttlMs: 60000 })
}, 60000)

afterAll(async () => {
  if (!RUN) return
  await bm.close() // flushes the jar — to the temp copy only
})

describe.skipIf(!RUN)('cookie jar vs. Yelp (live)', () => {
  const ctx: ToolContext = { credentials: {}, fetch: globalThis.fetch }

  it('fetches a Yelp business page through fetch_page', async () => {
    const result = (await fetchPage.handler({ url: BIZ_URL }, ctx)) as {
      error?: string
      content?: string
    }
    expect(result.error).toBeUndefined()
    expect(result.content ?? '').toContain('French Laundry')
  }, 60000)

  it('fetches Yelp search results through fetch_page', async () => {
    const result = (await fetchPage.handler({ url: SEARCH_URL }, ctx)) as {
      error?: string
      content?: string
    }
    expect(result.error).toBeUndefined()
    expect(result.content ?? '').toContain('Ramen')
  }, 60000)

  it('navigates a session to the biz page without tripping the block detector', async () => {
    const { id } = await sessions.create()
    try {
      const result = await sessions.run(id, (p) => browse.navigate(p, BIZ_URL))
      expect(result.blocked).toBeUndefined()
      expect(result.snapshot).toContain('French Laundry')
    } finally {
      await sessions.close(id)
    }
  }, 60000)
})
