import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findFirefoxProfile, firefoxExpiry, readFirefoxCookies } from './firefox-cookies.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'firefox-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// host, name, value, expiry, sameSite, originAttributes
type Row = [string, string, string, number, number, string]
function makeDb(rows: Row[]): string {
  const db = join(dir, 'cookies.sqlite')
  const d = new Database(db)
  d.exec(`CREATE TABLE moz_cookies(id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '',
            name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER,
            creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER);`)
  const ins = d.prepare(
    `INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes)
     VALUES (?, ?, ?, '/', ?, 1, 1, ?, ?)`,
  )
  for (const [host, name, value, expiry, sameSite, oa] of rows)
    ins.run(host, name, value, expiry, sameSite, oa)
  d.close()
  return db
}

const Y2099 = 4070908800

describe('firefoxExpiry', () => {
  it('passes seconds through and converts milliseconds', () => {
    expect(firefoxExpiry(Y2099)).toBe(Y2099)
    expect(firefoxExpiry(Y2099 * 1000)).toBe(Y2099)
  })
})

describe('readFirefoxCookies', () => {
  it('reads matching domains in Playwright shape, skipping containers and other sites', () => {
    const db = makeDb([
      ['.yelp.com', 'datadome', 'tok', Y2099, 0, ''],
      ['www.yelp.com', 'sess', 'abc', Y2099 * 1000, 1, ''],
      ['.yelp.com', 'datadome', 'container', Y2099, 0, '^userContextId=2'],
      ['.example.com', 'other', 'x', Y2099, 2, ''],
    ])
    const cookies = readFirefoxCookies(db, { domains: ['yelp.com'] })
    expect(cookies).toEqual([
      {
        name: 'datadome',
        value: 'tok',
        domain: '.yelp.com',
        path: '/',
        expires: Y2099,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
      {
        name: 'sess',
        value: 'abc',
        domain: 'www.yelp.com',
        path: '/',
        expires: Y2099,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ])
  })
})

describe('findFirefoxProfile', () => {
  function ini(root: string, body: string) {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'profiles.ini'), body)
  }

  it("prefers the install's default profile", () => {
    const root = join(dir, '.mozilla/firefox')
    ini(
      root,
      `[Profile1]\nName=old\nIsRelative=1\nPath=aaa.default\nDefault=1\n\n` +
        `[Profile0]\nName=main\nIsRelative=1\nPath=bbb.default-release\n\n` +
        `[Install4F96D1932A9F858E]\nDefault=bbb.default-release\nLocked=1\n`,
    )
    expect(findFirefoxProfile(dir)).toBe(join(root, 'bbb.default-release'))
  })

  it('falls back to the Default=1 profile, and handles absolute paths', () => {
    const root = join(dir, '.mozilla/firefox')
    ini(root, `[Profile0]\nName=x\nIsRelative=0\nPath=/abs/profile\nDefault=1\n`)
    expect(findFirefoxProfile(dir)).toBe('/abs/profile')
  })

  it('finds the XDG location, and returns undefined with no Firefox', () => {
    expect(findFirefoxProfile(dir)).toBeUndefined()
    const root = join(dir, '.config/mozilla/firefox')
    ini(root, `[Profile0]\nName=x\nIsRelative=1\nPath=p\n`)
    expect(findFirefoxProfile(dir)).toBe(join(root, 'p'))
  })
})
