// Desktop CLI: export a real browser's (Chrome or Firefox) cookies for chosen domains into
// a webfetch cookie jar. Run where the site works in a normal browser:
//   npm run export-cookies -- --domain yelp.com [--domain x.com] [--browser chrome|firefox]
//     [--profile DIR] [--out FILE] [--secret-file FILE]
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Cookie } from 'playwright-core'
import { matchesDomain, mergeJar, readChromeCookies, WrongSecretError } from './chrome-cookies.js'
import { findFirefoxProfile, readFirefoxCookies } from './firefox-cookies.js'

const USAGE =
  'usage: export-cookies --domain yelp.com [--domain ...] [--browser chrome|firefox] [--profile DIR] [--out FILE] [--secret-file FILE]'
const { values } = parseArgs({
  options: {
    domain: { type: 'string', multiple: true },
    browser: { type: 'string' },
    profile: { type: 'string' },
    out: { type: 'string', default: 'cookies.json' },
    'secret-file': { type: 'string' },
  },
})
const domains = values.domain ?? []
if (domains.length === 0 || (values.browser && !['chrome', 'firefox'].includes(values.browser))) {
  console.error(USAGE)
  process.exit(2)
}

const chromeDb = (dir: string) =>
  [join(dir, 'Network/Cookies'), join(dir, 'Cookies')].find(existsSync)
const firefoxDb = (dir: string) => [join(dir, 'cookies.sqlite')].find(existsSync)

// Work out which browser and profile to read: an explicit --profile says which by its
// files; otherwise use the default profile of whichever browser is installed.
let browser = values.browser as 'chrome' | 'firefox' | undefined
let profile = values.profile
if (profile) {
  browser ??= firefoxDb(profile) ? 'firefox' : 'chrome'
} else {
  const found = {
    chrome: chromeDb(join(homedir(), '.config/google-chrome/Default'))
      ? join(homedir(), '.config/google-chrome/Default')
      : undefined,
    firefox: findFirefoxProfile(homedir()),
  }
  if (!browser) {
    if (found.chrome && found.firefox) {
      console.error('found both Chrome and Firefox — pick one with --browser chrome|firefox')
      process.exit(1)
    }
    browser = found.firefox ? 'firefox' : 'chrome'
  }
  profile = found[browser]
  if (!profile) {
    console.error(`no ${browser} profile found — pass --profile DIR`)
    process.exit(1)
  }
}
const browserName = browser === 'firefox' ? 'Firefox' : 'Chrome'
const dbPath = browser === 'firefox' ? firefoxDb(profile) : chromeDb(profile)
if (!dbPath) {
  console.error(`no ${browserName} cookie database under ${profile}`)
  process.exit(1)
}

function keyringSecret(): string | undefined {
  if (values['secret-file']) return readFileSync(values['secret-file'], 'utf8').trim()
  try {
    return (
      execFileSync('secret-tool', ['lookup', 'application', 'chrome'], {
        encoding: 'utf8',
      }).trim() || undefined
    )
  } catch {
    return undefined
  }
}

let fresh: Cookie[]
try {
  fresh =
    browser === 'firefox'
      ? readFirefoxCookies(dbPath, { domains })
      : readChromeCookies(dbPath, { secret: keyringSecret(), domains })
} catch (err) {
  if (err instanceof WrongSecretError) {
    console.error(`could not decrypt Chrome's cookies: ${err.message}`)
    process.exit(1)
  }
  throw err
}

// Browsers keep expired cookies on disk until they get around to purging them.
const now = Date.now() / 1000
fresh = fresh.filter((c) => c.expires === -1 || c.expires > now)

// A domain with no cookies means the wrong browser/profile (or a site never visited
// there) — writing a jar without it would just look like a stale jar later.
const counts = domains.map((d) => [d, fresh.filter((c) => matchesDomain(c.domain, d)).length])
const missing = counts.filter(([, n]) => n === 0).map(([d]) => d)
if (missing.length > 0) {
  console.error(
    `no cookies for ${missing.join(', ')} in ${browserName} profile ${profile} — ` +
      'visit the site there first, or point --browser/--profile at the browser you use for it',
  )
  process.exit(1)
}

let existing: Cookie[] = []
if (existsSync(values.out)) {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(values.out, 'utf8'))
  } catch {
    console.error(`existing cookie jar ${values.out} is not valid JSON`)
    process.exit(1)
  }
  if (!Array.isArray(parsed)) {
    console.error(`existing cookie jar ${values.out} is not a JSON array of cookies`)
    process.exit(1)
  }
  existing = parsed as Cookie[]
  // Tighten an existing file before writing, so the cookies never sit at a looser mode
  // (writeFileSync's `mode` only applies when it creates the file).
  chmodSync(values.out, 0o600)
}
writeFileSync(values.out, JSON.stringify(mergeJar(existing, fresh, domains)), { mode: 0o600 })

console.log(`read ${browserName} profile ${profile}`)
for (const [d, n] of counts) console.log(`${d}: ${n} cookies`)
console.log(`\nwrote ${values.out}. Copy it to webfetch with:`)
console.log(
  `  cat ${values.out} | ssh docker 'docker exec -i webfetch sh -c "cat > /data/cookies.json && chmod 600 /data/cookies.json"'`,
)
