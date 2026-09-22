import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
  rmSync,
  existsSync,
  promises as fsp,
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

  it('a merge that lands while a write is in flight is not lost', async () => {
    writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'old')]))
    const jar = new CookieJar(path, { debounceMs: 10_000 })
    jar.cookies()
    jar.merge([ck('datadome', '.yelp.com', 'first')])

    // Signal once writeNow has actually called writeFile (so it has already captured its
    // pre-merge snapshot as an argument), then stall inside the call until released.
    let entered: () => void = () => {}
    const enteredGate = new Promise<void>((r) => (entered = r))
    let release: () => void = () => {}
    const stallGate = new Promise<void>((r) => (release = r))
    const realWriteFile = fsp.writeFile.bind(fsp)
    const spy = vi
      .spyOn(fsp, 'writeFile')
      .mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
        entered()
        await stallGate
        return realWriteFile(...args)
      })

    const flush1 = jar.flush()
    await enteredGate // writeNow is now stalled inside writeFile, snapshot already captured
    // A merge lands while the first write is stalled mid-flight.
    jar.merge([ck('datadome', '.yelp.com', 'second')])
    release()
    await flush1
    spy.mockRestore()

    await jar.flush()
    const written = JSON.parse(readFileSync(path, 'utf8')) as Cookie[]
    expect(written[0].value).toBe('second')
  })

  it('merge keeps a related cookie regardless of which side is the parent domain', () => {
    writeFileSync(path, JSON.stringify([ck('seed', 'www.yelp.com')]))
    const jar = new CookieJar(path, { debounceMs: 10_000 })
    jar.cookies()
    jar.merge([ck('datadome', '.yelp.com', 'rotated'), ck('other', '.other.com')])
    const domains = jar.cookies().map((c) => c.domain)
    expect(domains).toContain('.yelp.com') // parent domain kept: related to www.yelp.com
    expect(domains).not.toContain('.other.com') // unrelated domain dropped
  })
})
