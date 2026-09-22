import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Cookie } from 'playwright-core'
import { BrowserManager } from './browser-manager.js'
import { CookieJar } from './cookie-jar.js'

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

/**
 * Shared fakes with an ordered event log, so tests can assert *when* things
 * happen relative to each other (merge before close, close before flush,
 * flush before browser.close), not just that they happened.
 */
function makeFakes(
  opts: { failInject?: boolean; failCookies?: boolean; failNewPage?: boolean } = {},
) {
  const events: string[] = []
  const injectedContexts: unknown[] = []

  const jar = {
    injected: 0,
    merged: [] as Cookie[][],
    flushed: 0,
    async inject(ctx: unknown) {
      injectedContexts.push(ctx)
      if (opts.failInject) {
        throw new Error('inject failed')
      }
      events.push('inject')
      this.injected++
      return new Map()
    },
    mergeChanged(_seed: unknown, c: Cookie[]) {
      events.push('merge')
      this.merged.push(c)
    },
    async flush() {
      events.push('flush')
      this.flushed++
    },
  }

  const contexts: Array<{ closed: boolean }> = []
  const browser = {
    contexts,
    isConnected: () => true,
    close: async () => {
      events.push('browser.close')
    },
    newContext: async () => {
      const ctx = {
        closed: false,
        // A real BrowserContext.cookies() throws once the context is closed.
        cookies: async () => {
          if (ctx.closed) throw new Error('cookies: context is closed')
          if (opts.failCookies) throw new Error('cookies failed')
          return [ck('datadome', 'rotated')]
        },
        addCookies: async () => {},
        newPage: async () => {
          if (opts.failNewPage) throw new Error('newPage failed')
          const page = {
            closed: false,
            isClosed: () => page.closed,
            close: async () => {
              page.closed = true
            },
          }
          return page
        },
        close: async () => {
          ctx.closed = true
          events.push('ctx.close')
        },
      }
      contexts.push(ctx)
      return ctx
    },
  }

  return { events, jar, browser, injectedContexts }
}

describe('BrowserManager cookie jar', () => {
  it('injects the jar into session and temp contexts, passing the context it created', async () => {
    const { jar, browser, injectedContexts } = makeFakes()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const session = await bm.getSession('s1')
    const temp = await bm.createTempPage()
    expect(jar.injected).toBe(2)
    expect(injectedContexts).toEqual([session.context, temp.context])
  })

  it('writes cookies back before closing a context, and flushes on shutdown, in order', async () => {
    const { events, jar, browser } = makeFakes()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const { context: tempCtx } = await bm.createTempPage()
    await bm.closeContext(tempCtx)
    await bm.getSession('s1')
    await bm.close()
    expect(jar.merged.length).toBe(2) // temp context + session context
    expect(jar.merged[0][0].value).toBe('rotated')
    expect(browser.contexts.every((c) => c.closed)).toBe(true)
    expect(jar.flushed).toBe(1)
    expect(events).toEqual([
      'inject', // temp context created
      'merge',
      'ctx.close', // temp context closed via closeContext
      'inject', // session context created
      'merge',
      'ctx.close', // session context closed via close()
      'flush',
      'browser.close',
    ])
  })

  it('works without a jar', async () => {
    const { browser } = makeFakes()
    const bm = new BrowserManager({ launch: async () => browser as never })
    const { context } = await bm.createTempPage()
    await expect(bm.closeContext(context)).resolves.toBeUndefined()
  })

  it('cookies() throws once the context is closed, and a later closeContext stays harmless', async () => {
    const { events, jar, browser } = makeFakes()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const { context } = await bm.createTempPage()
    await bm.closeContext(context)
    expect(events).toEqual(['inject', 'merge', 'ctx.close'])

    // Simulates browserFetch's `finally` calling closeContext again on a
    // context that BrowserManager.close() already tore down.
    await expect(bm.closeContext(context)).resolves.toBeUndefined()
    expect(jar.merged).toHaveLength(1) // second cookies() call threw, so no second merge
    expect(events).toEqual(['inject', 'merge', 'ctx.close', 'ctx.close'])
  })

  it('getSession still resolves with a usable page when inject rejects', async () => {
    const { jar, browser } = makeFakes({ failInject: true })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const session = await bm.getSession('s1')
    expect(session.page.isClosed()).toBe(false)
    consoleSpy.mockRestore()
  })

  it('closeContext resolves and closes the context when cookies() rejects', async () => {
    const { jar, browser } = makeFakes({ failCookies: true })
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const { context } = await bm.createTempPage()
    await expect(bm.closeContext(context)).resolves.toBeUndefined()
    expect(browser.contexts[0].closed).toBe(true)
    expect(jar.merged).toHaveLength(0)
  })

  it('close() merges and closes temp contexts still in flight, before flush', async () => {
    const { events, jar, browser } = makeFakes()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    await bm.createTempPage() // not closed — simulates a fetch mid-navigation at shutdown
    await bm.close()
    expect(browser.contexts[0].closed).toBe(true)
    expect(jar.merged).toHaveLength(1)
    expect(events).toEqual(['inject', 'merge', 'ctx.close', 'flush', 'browser.close'])
  })

  it('a later closeContext on an already-closed temp context stays harmless after close()', async () => {
    const { jar, browser } = makeFakes()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const { context } = await bm.createTempPage()
    await bm.close()
    await expect(bm.closeContext(context)).resolves.toBeUndefined()
    expect(jar.merged).toHaveLength(1) // no extra merge from the harmless second close
  })

  it('close() is idempotent: two concurrent calls produce one flush and one browser.close, after the merges', async () => {
    const { events, jar, browser } = makeFakes()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    await bm.getSession('s1')
    const [p1, p2] = [bm.close(), bm.close()]
    await Promise.all([p1, p2])
    expect(jar.flushed).toBe(1)
    expect(events.filter((e) => e === 'browser.close')).toHaveLength(1)
    expect(events.filter((e) => e === 'merge')).toHaveLength(1)
    expect(events.indexOf('merge')).toBeLessThan(events.indexOf('flush'))
    expect(events.indexOf('flush')).toBeLessThan(events.indexOf('browser.close'))

    // A third call after settling should also just resolve, with no further effects.
    await bm.close()
    expect(jar.flushed).toBe(1)
    expect(events.filter((e) => e === 'browser.close')).toHaveLength(1)
  })

  it('closes the old context before creating a replacement when the session page is closed', async () => {
    const { events, jar, browser } = makeFakes()
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    const first = await bm.getSession('s1')
    await first.page.close()
    const second = await bm.getSession('s1')
    expect(second.context).not.toBe(first.context)
    expect(browser.contexts[0].closed).toBe(true) // old context closed
    expect(jar.merged).toHaveLength(1) // old context's cookies merged
    expect(events).toEqual(['inject', 'merge', 'ctx.close', 'inject'])
  })

  it("closes the context without merging when getSession()'s newPage() fails", async () => {
    const { events, jar, browser } = makeFakes({ failNewPage: true })
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    await expect(bm.getSession('s1')).rejects.toThrow('newPage failed')
    expect(browser.contexts).toHaveLength(1)
    expect(browser.contexts[0].closed).toBe(true)
    expect(events).toEqual(['inject', 'ctx.close']) // no merge — nothing to write back
    expect(jar.merged).toHaveLength(0)
  })

  it("closes the context without merging when createTempPage()'s newPage() fails", async () => {
    const { events, jar, browser } = makeFakes({ failNewPage: true })
    const bm = new BrowserManager({ jar: jar as never, launch: async () => browser as never })
    await expect(bm.createTempPage()).rejects.toThrow('newPage failed')
    expect(browser.contexts).toHaveLength(1)
    expect(browser.contexts[0].closed).toBe(true)
    expect(events).toEqual(['inject', 'ctx.close'])
    expect(jar.merged).toHaveLength(0)
  })
})

/** A fake browser whose contexts really hold cookies: addCookies stores, cookies() returns. */
function cookieBrowser() {
  return {
    isConnected: () => true,
    close: async () => {},
    newContext: async () => {
      const store = new Map<string, Cookie>()
      const key = (c: Cookie) => `${c.name}|${c.domain}|${c.path}`
      return {
        store,
        set: (c: Cookie) => store.set(key(c), c),
        addCookies: async (cs: Cookie[]) => cs.forEach((c) => store.set(key(c), c)),
        cookies: async () => [...store.values()],
        newPage: async () => ({ isClosed: () => false }),
        close: async () => {},
      }
    },
  }
}

describe('BrowserManager write-back against a real CookieJar', () => {
  const future = Date.now() / 1000 + 86400
  const dd = (value: string): Cookie => ({ ...ck('datadome', value), expires: future })
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-jar-'))
    path = join(dir, 'cookies.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const onDisk = () => (JSON.parse(readFileSync(path, 'utf8')) as Cookie[])[0].value

  it('a context closing after the jar was re-delivered does not revert it', async () => {
    writeFileSync(path, JSON.stringify([dd('OLD')]))
    const jar = new CookieJar(path, { debounceMs: 10_000 })
    const bm = new BrowserManager({ jar, launch: async () => cookieBrowser() as never })
    const a = await bm.createTempPage() // seeded with OLD
    writeFileSync(path, JSON.stringify([dd('NEW')]))
    const t = new Date(Date.now() + 5000)
    utimesSync(path, t, t)
    await bm.createTempPage() // hot-reloads NEW
    await bm.closeContext(a.context)
    await jar.flush()
    expect(onDisk()).toBe('NEW')
  })

  it('a rotation in one context is not reverted by another closing later with its seed copy', async () => {
    writeFileSync(path, JSON.stringify([dd('X')]))
    const jar = new CookieJar(path, { debounceMs: 10_000 })
    const bm = new BrowserManager({ jar, launch: async () => cookieBrowser() as never })
    const a = await bm.createTempPage()
    const b = await bm.createTempPage()
    ;(b.context as unknown as { set: (c: Cookie) => void }).set(dd('Y')) // site rotates in B
    await bm.closeContext(b.context)
    await bm.closeContext(a.context)
    await jar.flush()
    expect(onDisk()).toBe('Y')
  })
})
