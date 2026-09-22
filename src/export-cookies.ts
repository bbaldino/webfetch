// Desktop CLI: export a real Chrome's cookies for chosen domains into a webfetch cookie
// jar. Run where the site works in a normal browser:
//   npm run export-cookies -- --domain yelp.com [--domain x.com] [--profile DIR] [--out FILE] [--secret-file FILE]
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Cookie } from 'playwright-core'
import { matchesDomain, mergeJar, readChromeCookies, WrongSecretError } from './chrome-cookies.js'

const { values } = parseArgs({
  options: {
    domain: { type: 'string', multiple: true },
    profile: { type: 'string', default: join(homedir(), '.config/google-chrome/Default') },
    out: { type: 'string', default: 'cookies.json' },
    'secret-file': { type: 'string' },
  },
})
const domains = values.domain ?? []
if (domains.length === 0) {
  console.error(
    'usage: export-cookies --domain yelp.com [--domain ...] [--profile DIR] [--out FILE] [--secret-file FILE]',
  )
  process.exit(2)
}

const dbPath = [join(values.profile, 'Network/Cookies'), join(values.profile, 'Cookies')].find(
  existsSync,
)
if (!dbPath) {
  console.error(`no Chrome Cookies database under ${values.profile}`)
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
  fresh = readChromeCookies(dbPath, { secret: keyringSecret(), domains })
} catch (err) {
  if (err instanceof WrongSecretError) {
    console.error(`could not decrypt Chrome's cookies: ${err.message}`)
    process.exit(1)
  }
  throw err
}

let existing: Cookie[] = []
if (existsSync(values.out)) {
  try {
    existing = JSON.parse(readFileSync(values.out, 'utf8'))
  } catch {
    console.error(`existing cookie jar ${values.out} is not valid JSON`)
    process.exit(1)
  }
}
writeFileSync(values.out, JSON.stringify(mergeJar(existing, fresh, domains)), { mode: 0o600 })
chmodSync(values.out, 0o600)

for (const d of domains) {
  console.log(`${d}: ${fresh.filter((c) => matchesDomain(c.domain, d)).length} cookies`)
}
console.log(`\nwrote ${values.out}. Copy it to webfetch with:`)
console.log(
  `  cat ${values.out} | ssh docker 'docker exec -i webfetch sh -c "cat > /data/cookies.json && chmod 600 /data/cookies.json"'`,
)
