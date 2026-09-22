// Reads and decrypts a desktop Chrome (Linux) Cookies database into Playwright cookies.
// Linux Chrome encrypts values with a key derived from the keyring secret ("v11") or, with
// no keyring, the fixed "peanuts" password ("v10"). DB schema >= 24 prefixes each
// plaintext with SHA256(host_key), which doubles as a check that the secret is right.
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import type { Cookie } from 'playwright-core'
import { withSqliteCopy } from './sqlite-copy.js'

export class WrongSecretError extends Error {}

export const deriveKey = (secret: string): Buffer => pbkdf2Sync(secret, 'saltysalt', 1, 16, 'sha1')

export function decryptValue(
  blob: Buffer,
  hostKey: string,
  keys: { v10: Buffer; v11?: Buffer },
  schema: number,
): string {
  const prefix = blob.subarray(0, 3).toString()
  if (prefix !== 'v10' && prefix !== 'v11') return blob.toString('utf8')
  const key = prefix === 'v10' ? keys.v10 : keys.v11
  if (!key)
    throw new WrongSecretError('cookie is keyring-encrypted but no keyring secret is available')
  let plain: Buffer
  try {
    const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    plain = Buffer.concat([d.update(blob.subarray(3)), d.final()])
  } catch {
    throw new WrongSecretError('decryption failed — wrong keyring secret?')
  }
  if (schema >= 24) {
    if (!plain.subarray(0, 32).equals(createHash('sha256').update(hostKey).digest())) {
      throw new WrongSecretError('host hash mismatch — wrong keyring secret')
    }
    plain = plain.subarray(32)
  }
  // For schema < 24 there's no host-hash to check, so a wrong key is only caught above via
  // a PKCS7 padding failure — which can rarely still "succeed" on garbage plaintext, in
  // which case this returns junk rather than throwing.
  return plain.toString('utf8')
}

export const chromeTimeToUnix = (us: number): number => (us === 0 ? -1 : us / 1e6 - 11644473600)

export const chromeSameSite = (code: number): Cookie['sameSite'] =>
  code === 0 ? 'None' : code === 2 ? 'Strict' : 'Lax'

const bare = (d: string) => d.replace(/^\./, '').toLowerCase()

export function matchesDomain(hostKey: string, domain: string): boolean {
  const h = bare(hostKey)
  const d = bare(domain)
  return h === d || h.endsWith(`.${d}`)
}

interface Row {
  host_key: string
  name: string
  value: string
  encrypted_value: Buffer
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
}

export function readChromeCookies(
  dbPath: string,
  opts: { secret?: string; domains: string[] },
): Cookie[] {
  return withSqliteCopy(dbPath, (db) => {
    const schema = Number(
      (db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get() as { value: string }).value,
    )
    const keys = {
      v10: deriveKey('peanuts'),
      v11: opts.secret ? deriveKey(opts.secret) : undefined,
    }
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies`,
      )
      .all() as Row[]
    return rows
      .filter((r) => opts.domains.some((d) => matchesDomain(r.host_key, d)))
      .map((r) => ({
        name: r.name,
        // Deliberately let decryptValue's WrongSecretError propagate and abort the whole
        // export rather than skipping the one cookie: a decrypt failure means the
        // keyring secret is wrong or missing, which is systematic (every keyring-
        // encrypted cookie will fail the same way), and a partial jar that's silently
        // missing e.g. the datadome cookie is worse than a loud, obvious failure.
        value: r.encrypted_value?.length
          ? decryptValue(r.encrypted_value, r.host_key, keys, schema)
          : r.value,
        domain: r.host_key,
        path: r.path,
        expires: chromeTimeToUnix(r.expires_utc),
        httpOnly: r.is_httponly === 1,
        secure: r.is_secure === 1,
        sameSite: chromeSameSite(r.samesite),
      }))
  })
}

export function mergeJar(existing: Cookie[], fresh: Cookie[], domains: string[]): Cookie[] {
  const kept = existing.filter((c) => !domains.some((d) => matchesDomain(c.domain, d)))
  return [...kept, ...fresh]
}
