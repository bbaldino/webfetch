import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deriveKey } from './chrome-cookies.js'

// Drives the real CLI in a subprocess against a synthetic Chrome profile.
const SECRET = 'test-keyring-secret'
const CHROME_2099 = (4070908800 + 11644473600) * 1e6

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'export-'))
  const host = '.yelp.com'
  const plain = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('tok')])
  const c = createCipheriv('aes-128-cbc', deriveKey(SECRET), Buffer.alloc(16, ' '))
  const blob = Buffer.concat([Buffer.from('v11'), c.update(plain), c.final()])
  const d = new Database(join(dir, 'Cookies'))
  d.exec(`CREATE TABLE meta(key TEXT, value TEXT);
          CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
            expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);`)
  d.prepare(`INSERT INTO meta VALUES ('version', '24')`).run()
  d.prepare(`INSERT INTO cookies VALUES (?, 'datadome', '', ?, '/', ?, 1, 1, 1)`).run(
    host,
    blob,
    CHROME_2099,
  )
  d.close()
  writeFileSync(join(dir, 'secret'), SECRET)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cli = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/export-cookies.ts', ...args], {
    encoding: 'utf8',
  })
const run = (out: string, domain = 'yelp.com') =>
  cli(['--domain', domain, '--profile', dir, '--secret-file', join(dir, 'secret'), '--out', out])

describe('export-cookies CLI', () => {
  it('exits 1 with a friendly message when --out is valid JSON but not an array', () => {
    const out = join(dir, 'jar.json')
    writeFileSync(out, '{}')
    const r = run(out)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/is not a JSON array/)
    expect(r.stderr).not.toMatch(/\n\s+at /) // no stack trace
    expect(readFileSync(out, 'utf8')).toBe('{}')
  })

  it('leaves a pre-existing 0644 jar at mode 600, merged', () => {
    const out = join(dir, 'jar.json')
    writeFileSync(out, '[]')
    chmodSync(out, 0o644)
    const r = run(out)
    expect(r.status).toBe(0)
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toHaveLength(1)
    expect(r.stdout).not.toContain('tok') // never prints values
  })

  it('refuses to write a jar when a domain matched no cookies', () => {
    const out = join(dir, 'jar.json')
    const r = run(out, 'nope.com')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no cookies for nope\.com/)
    expect(existsSync(out)).toBe(false)
  })

  it('exports from a Firefox profile (unencrypted cookies.sqlite)', () => {
    const ff = join(dir, 'ff')
    mkdirSync(ff)
    const d = new Database(join(ff, 'cookies.sqlite'))
    d.exec(`CREATE TABLE moz_cookies(originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
              host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER);`)
    d.prepare(
      `INSERT INTO moz_cookies VALUES ('', 'datadome', 'fftok', '.yelp.com', '/', 4070908800, 1, 1, 0)`,
    ).run()
    d.prepare(
      `INSERT INTO moz_cookies VALUES ('', 'old', 'x', '.yelp.com', '/', 1000000000, 1, 1, 0)`,
    ).run()
    d.close()
    const out = join(dir, 'jar.json')
    const r = cli(['--domain', 'yelp.com', '--profile', ff, '--out', out])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Firefox/)
    expect(r.stdout).not.toContain('fftok')
    const jar = JSON.parse(readFileSync(out, 'utf8'))
    expect(jar).toEqual([expect.objectContaining({ name: 'datadome', domain: '.yelp.com' })])
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })
})
