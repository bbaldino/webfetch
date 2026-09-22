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
