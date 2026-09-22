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
