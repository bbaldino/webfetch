import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const run = (out: string) =>
  spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/export-cookies.ts',
      '--domain',
      'yelp.com',
      '--profile',
      dir,
      '--secret-file',
      join(dir, 'secret'),
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  )

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
})
