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

  describe('seed-diffed write-back (mergeChanged)', () => {
    const fakeCtx = () => {
      const added: Cookie[] = []
      return { added, addCookies: async (c: readonly Cookie[]) => void added.push(...c) }
    }

    it('a late close does not revert a re-delivered jar (the C1 repro)', async () => {
      writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'OLD')]))
      const jar = new CookieJar(path, { debounceMs: 10_000 })
      const a = fakeCtx()
      const seedA = await jar.inject(a) // context A opens with OLD
      writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'NEW')]))
      bump(path)
      await jar.inject(fakeCtx()) // next context hot-reloads NEW
      jar.mergeChanged(seedA, a.added) // A closes with its unchanged seed copy
      await jar.flush()
      expect((JSON.parse(readFileSync(path, 'utf8')) as Cookie[])[0].value).toBe('NEW')
    })

    it("one context's rotation survives another closing later with an unchanged seed", async () => {
      writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'X')]))
      const jar = new CookieJar(path, { debounceMs: 10_000 })
      const a = fakeCtx()
      const b = fakeCtx()
      const seedA = await jar.inject(a)
      const seedB = await jar.inject(b)
      jar.mergeChanged(seedB, [ck('datadome', '.yelp.com', 'Y')]) // B rotated X -> Y
      jar.mergeChanged(seedA, a.added) // A closes later, untouched
      await jar.flush()
      expect((JSON.parse(readFileSync(path, 'utf8')) as Cookie[])[0].value).toBe('Y')
    })

    it('an expiry-only refresh does not revert a value another context rotated', async () => {
      writeFileSync(path, JSON.stringify([ck('datadome', '.yelp.com', 'X')]))
      const jar = new CookieJar(path, { debounceMs: 10_000 })
      const seedA = await jar.inject(fakeCtx())
      const seedB = await jar.inject(fakeCtx())
      jar.mergeChanged(seedB, [ck('datadome', '.yelp.com', 'Y')])
      jar.mergeChanged(seedA, [ck('datadome', '.yelp.com', 'X', future + 3600)])
      expect(jar.cookies()[0].value).toBe('Y')
    })

    it('writes back cookies the context rotated or added, and ignores sub-second expiry drift', async () => {
      writeFileSync(
        path,
        JSON.stringify([
          ck('datadome', '.yelp.com', 'X'),
          ck('keep', '.yelp.com', 'k', future + 0.5),
        ]),
      )
      const jar = new CookieJar(path, { debounceMs: 10_000 })
      const seed = await jar.inject(fakeCtx())
      jar.mergeChanged(seed, [
        ck('datadome', '.yelp.com', 'Z'),
        ck('keep', '.yelp.com', 'k', Math.round(future + 0.5)), // browser round-trip
        ck('fresh', '.yelp.com', 'f'),
      ])
      const byName = Object.fromEntries(jar.cookies().map((c) => [c.name, c]))
      expect(byName.datadome.value).toBe('Z')
      expect(byName.fresh.value).toBe('f')
      expect(byName.keep.expires).toBe(future + 0.5) // untouched: drift isn't a change
    })
  })

  describe('per-cookie validation (I1)', () => {
    it('normalizes sameSite casing, coerces a non-number expires, and fixes None-without-Secure', () => {
      writeFileSync(
        path,
        JSON.stringify([
          { ...ck('a', '.yelp.com'), sameSite: 'lax' },
          { ...ck('b', '.yelp.com'), sameSite: 'strict' },
          { ...ck('c', '.yelp.com'), sameSite: 'no_restriction', secure: true },
          { ...ck('d', '.yelp.com'), sameSite: 'none', secure: false },
          { ...ck('e', '.yelp.com'), expires: 'soon' },
          { ...ck('f', '.yelp.com'), sameSite: undefined, httpOnly: undefined },
        ]),
      )
      const byName = Object.fromEntries(new CookieJar(path).cookies().map((c) => [c.name, c]))
      expect(byName.a.sameSite).toBe('Lax')
      expect(byName.b.sameSite).toBe('Strict')
      expect(byName.c.sameSite).toBe('None')
      expect(byName.d.sameSite).toBe('Lax')
      expect(byName.e.expires).toBe(-1)
      expect(byName.f).toMatchObject({ sameSite: 'Lax', httpOnly: false })
    })

    it('drops invalid entries, logging only a count, and keeps the rest', () => {
      writeFileSync(
        path,
        JSON.stringify([
          ck('good', '.yelp.com', 'secretvalue'),
          { name: 'nodomain', value: 'secretvalue', path: '/' },
          { ...ck('nopath', '.yelp.com', 'secretvalue'), path: undefined },
          { ...ck('novalue', '.yelp.com'), value: 42 },
          { ...ck('', '.yelp.com') },
          'not an object',
          null,
        ]),
      )
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      const jar = new CookieJar(path)
      expect(jar.cookies().map((c) => c.name)).toEqual(['good'])
      expect(() => jar.covers('www.yelp.com')).not.toThrow()
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
      expect(logged).toContain('6')
      expect(logged).not.toMatch(/secretvalue|nodomain|nopath|novalue/)
      warn.mockRestore()
    })

    it('falls back to one-at-a-time when the batch is rejected, skipping only the bad cookie', async () => {
      writeFileSync(
        path,
        JSON.stringify([ck('a', '.yelp.com'), ck('bad', '.yelp.com'), ck('c', '.yelp.com')]),
      )
      const added: string[] = []
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      const seed = await new CookieJar(path).inject({
        addCookies: async (cs) => {
          if (cs.some((c) => c.name === 'bad')) throw new Error('Browser.setCookies failed')
          added.push(...cs.map((c) => c.name))
        },
      })
      expect(added).toEqual(['a', 'c'])
      expect(seed.size).toBe(2) // the skipped cookie isn't part of the seed
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
      expect(logged).toContain('1 of 3')
      expect(logged).not.toMatch(/re-export|bad/)
      warn.mockRestore()
    })
  })

  it('a parse failure keeps the previous jar and retries on the next call, even at the same mtime', () => {
    writeFileSync(path, JSON.stringify([ck('a', '.yelp.com')]))
    const jar = new CookieJar(path)
    expect(jar.cookies().map((c) => c.name)).toEqual(['a'])
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = new Date(Date.now() + 5000)
    writeFileSync(path, '[{"name":') // a half-written in-place copy
    utimesSync(path, t, t)
    expect(jar.cookies().map((c) => c.name)).toEqual(['a']) // previous jar kept
    writeFileSync(path, JSON.stringify([ck('b', '.yelp.com')]))
    utimesSync(path, t, t) // coarse timestamps: the finished copy shares the partial's mtime
    expect(jar.cookies().map((c) => c.name)).toEqual(['b'])
    warn.mockRestore()
  })

  it('write-back does not persist new session cookies, but updates ones already in the jar', () => {
    writeFileSync(
      path,
      JSON.stringify([ck('datadome', '.yelp.com'), ck('s', '.yelp.com', 'v', -1)]),
    )
    const jar = new CookieJar(path, { debounceMs: 10_000 })
    jar.cookies()
    jar.merge([ck('sess', '.yelp.com', 'x', -1), ck('s', '.yelp.com', 'rotated', -1)])
    const byName = Object.fromEntries(jar.cookies().map((c) => [c.name, c.value]))
    expect(byName).toEqual({ datadome: 'v', s: 'rotated' })
  })

  it('covers() is bidirectional like merge: a host-only www cookie covers the bare domain', () => {
    writeFileSync(path, JSON.stringify([ck('a', 'www.yelp.com')]))
    const jar = new CookieJar(path)
    expect(jar.covers('www.yelp.com')).toBe(true)
    expect(jar.covers('yelp.com')).toBe(true)
    expect(jar.covers('api.www.yelp.com')).toBe(true)
    expect(jar.covers('notyelp.com')).toBe(false)
  })
})
