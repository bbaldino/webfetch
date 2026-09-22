// Reads a desktop Firefox profile's cookies.sqlite into Playwright cookies. Unlike Chrome,
// Firefox stores cookie values unencrypted, so no keyring secret is involved.
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Cookie } from 'playwright-core'
import { matchesDomain } from './chrome-cookies.js'
import { withSqliteCopy } from './sqlite-copy.js'

// Newer Firefox stores expiry in milliseconds, older in seconds; no real expiry in
// seconds gets anywhere near 1e11 (year 5138), so the magnitude tells them apart.
export const firefoxExpiry = (n: number): number => (n > 1e11 ? Math.floor(n / 1000) : n)

const firefoxSameSite = (code: number): Cookie['sameSite'] =>
  code === 2 ? 'Strict' : code === 1 ? 'Lax' : 'None'

interface Row {
  host: string
  name: string
  value: string
  path: string
  expiry: number
  isSecure: number
  isHttpOnly: number
  sameSite: number
}

export function readFirefoxCookies(dbPath: string, opts: { domains: string[] }): Cookie[] {
  return withSqliteCopy(dbPath, (db) => {
    // originAttributes = '' is the normal browsing jar; skip container, private-window
    // and partitioned (third-party) cookies, which the site doesn't see on a normal visit.
    const rows = db
      .prepare(
        `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
           FROM moz_cookies WHERE originAttributes = ''`,
      )
      .all() as Row[]
    return rows
      .filter((r) => opts.domains.some((d) => matchesDomain(r.host, d)))
      .map((r) => ({
        name: r.name,
        value: r.value,
        domain: r.host,
        path: r.path,
        expires: firefoxExpiry(r.expiry),
        httpOnly: r.isHttpOnly === 1,
        secure: r.isSecure === 1,
        sameSite: firefoxSameSite(r.sameSite),
      }))
  })
}

// Where Firefox keeps profiles.ini: classic, XDG (newer Firefox), Snap and Flatpak.
const FIREFOX_ROOTS = [
  '.mozilla/firefox',
  '.config/mozilla/firefox',
  'snap/firefox/common/.mozilla/firefox',
  '.var/app/org.mozilla.firefox/.mozilla/firefox',
]

/** The profile directory Firefox opens by default, or undefined if there's no Firefox. */
export function findFirefoxProfile(home: string): string | undefined {
  for (const rel of FIREFOX_ROOTS) {
    const root = join(home, rel)
    const iniPath = join(root, 'profiles.ini')
    if (!existsSync(iniPath)) continue
    const sections = parseIni(readFileSync(iniPath, 'utf8'))
    const resolve = (path: string, relative = true) =>
      relative && !isAbsolute(path) ? join(root, path) : path
    // Modern Firefox records each install's default in an [Install…] section.
    const install = sections.find((s) => s.name.startsWith('Install') && s.keys.Default)
    if (install) return resolve(install.keys.Default)
    const profiles = sections.filter((s) => s.name.startsWith('Profile') && s.keys.Path)
    const pick = profiles.find((s) => s.keys.Default === '1') ?? profiles[0]
    if (pick) return resolve(pick.keys.Path, pick.keys.IsRelative !== '0')
  }
  return undefined
}

function parseIni(text: string): Array<{ name: string; keys: Record<string, string> }> {
  const sections: Array<{ name: string; keys: Record<string, string> }> = []
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/)
    if (header) sections.push({ name: header[1], keys: {} })
    else {
      const kv = line.match(/^\s*([^=#;]+?)\s*=\s*(.*?)\s*$/)
      if (kv && sections.length > 0) sections[sections.length - 1].keys[kv[1]] = kv[2]
    }
  }
  return sections
}
