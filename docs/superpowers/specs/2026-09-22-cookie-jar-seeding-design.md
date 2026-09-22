# Cookie-jar seeding for bot-protected sites — design

**Status:** approved design, pre-implementation
**Date:** 2026-09-22

## Goal

Let webfetch fetch and browse sites behind DataDome-class bot protection — Yelp
first, including search — by injecting a cookie jar exported from a real,
long-used desktop browser into every Camoufox browser context. Along the way,
stop reporting a blocked page as a successful empty fetch.

## Background: what the investigation showed

Yelp is protected by DataDome. A spike on 2026-09-22 (hardac, and inside a
Docker container on the webfetch VM; same public IP) established:

- Every **browser-only** approach fails: Camoufox headless or on a virtual
  display, stealth Chromium (`rebrowser-playwright` + `puppeteer-extra-plugin-stealth`),
  a freshly hand-primed profile, in-page `fetch()` injection, and CDP-attaching
  to a live hand-solved browser.
- Injecting the **aged cookies from a real desktop Chrome** (including the
  `datadome` cookie, 365-day expiry) into a fresh context passes Yelp business
  pages and search, headless.
- Head-to-head on the browse-bench corpus (2 runs per site):

  | Arm                    | Result                            |
  | ---------------------- | --------------------------------- |
  | Camoufox headless      | 7/9 — fails Yelp biz + search     |
  | Camoufox + cookie jar  | **9/9**                           |
  | Stealth Chromium       | 5/9 — fails Yelp, Wayfair, Reddit |
  | Stealth Chromium + jar | 7/9 — fails Wayfair, Reddit       |

The cookie jar is the whole fix. The engine doesn't need to change — Camoufox
stays the only browser, and stealth Chromium is strictly worse here.

## Non-goals

- **No second browser engine.** Evidence above. (If one is ever needed: only
  full Chromium, `channel: 'chromium'`, works; the default headless-shell build
  is blocked on sight.)
- **No upload endpoint** in v1. The jar is delivered by copying a file. If
  re-exporting turns out to be frequent, a `PUT /cookies` endpoint is the
  follow-up.
- **No automated re-seeding.** Refreshing the jar is a human step (re-run the
  export on the desktop).
- **No per-site routing registry.** Browsers already scope cookies by domain,
  so one jar injected everywhere only ever sends Yelp's cookies to Yelp.
- Export supports **desktop Chrome on Linux** only (the user's setup).

## Architecture

```
desktop Chrome ──export-cookies──▶ cookies.json ──copy──▶ /data/cookies.json
                                                              │
                          ┌───────────────────────────────────┘
                          ▼
                     CookieJar ──inject on context create──▶ every Camoufox context
                          ▲                                   (fetch_page, /sessions, MCP)
                          └──────── merge on context close ◀──┘
```

### 1. `CookieJar` (`src/cookie-jar.ts`)

- File path from `WEBFETCH_COOKIE_JAR`, default `/data/cookies.json`. A missing
  file means an empty jar — not an error; webfetch runs exactly as today.
- Format: a JSON array of Playwright cookies (`name`, `value`, `domain`,
  `path`, `expires`, `httpOnly`, `secure`, `sameSite`) — the same shape
  `context.addCookies` / `context.cookies()` use, so no translation layer.
- **Hot reload:** before injecting, `stat` the file; re-read if its mtime
  changed. A copied-in jar takes effect on the next context, with no restart.
- **Domains:** the set of domains the jar holds cookies for (e.g. `yelp.com`),
  derived from cookie `domain` fields.
- **Write-back (`merge`):** take a context's cookies, keep only those whose
  domain is already covered by the jar, replace by `(name, domain, path)`, drop
  expired ones, and write atomically (temp file + rename, mode `600`),
  debounced and serialized so concurrent closes don't clobber each other. Only
  domains already in the jar are ever written back — the jar never
  accumulates cookies from arbitrary sites the browser visits.
- A malformed file logs one warning (to stderr) and is treated as empty; it
  never crashes the service. Cookie values are never logged.

### 2. `BrowserManager` integration

All three faces get their contexts from `BrowserManager` (`getSession` for
`/sessions` and the MCP tools, `createTempPage` for `fetch_page`'s browser
path), so this is the single integration point:

- After creating a context: `await context.addCookies(jar.cookies())`,
  sanitized so Playwright accepts them (e.g. `sameSite: 'None'` requires
  `secure`; `expires: -1` for session cookies).
- Before closing a context (session close/TTL eviction, temp-page close, and
  `BrowserManager.close()` at shutdown): `jar.merge(await context.cookies())`,
  best-effort — a failed write-back never fails the fetch.

Because every context gets the jar, a session that navigates from any site to
Yelp just works; there is no engine choice or switching.

### 3. Block detection and honest failures

A shared `detectBlock(status, html/text)` recognizes bot walls: DataDome
(`captcha-delivery.com`, a document that is only a challenge iframe with the
bare domain as title), `403`/`429` with an almost-empty body, and the existing
Reddit/`looksBlocked` signatures where they generalize.

- **`fetch_page` (REST `/fetch`, MCP `fetch_page`):** if the browser path
  extracts no content, or detects a block, return an error — which the REST
  face maps to `502` — instead of today's `200` with empty text. This fixes
  the root masking bug: the handler currently sets `error` to the browser's
  (empty) content, and `server.ts`'s truthiness check treats `""` as success.
  The error message names the cause:
  - domain has jar cookies → `"blocked by yelp.com's bot protection — its cookies in the cookie jar look stale; re-export them (see README)"`
  - otherwise → `"blocked by yelp.com's bot protection (no content extracted)"`
- **Sessions and MCP browse tools:** the `{ url, title, snapshot }` envelope
  gains an optional `blocked: { reason, hint }` field when the page after an
  operation is a detected bot wall, with the same stale-jar hint. The call
  still succeeds (the agent may want to look at the page), but it no longer
  has to guess from an iframe-only snapshot. Documented in `/openapi.json`.

### 4. Export tool (`scripts/export-cookies.ts`, `npm run export-cookies`)

Run on the desktop where the site works in a normal browser:

```
npm run export-cookies -- --domain yelp.com [--domain other.com] \
  [--profile ~/.config/google-chrome/Default] [--out cookies.json]
```

- Copies Chrome's `Cookies` SQLite DB to a temp file (Chrome holds a lock) and
  reads it with `better-sqlite3` (already a dependency).
- Gets the keyring secret via `secret-tool lookup application chrome`; falls
  back to `--secret-file`, and to Chrome's basic-store key for `v10` values.
- Decrypts with `node:crypto`: PBKDF2-SHA1(secret, `saltysalt`, 1 iteration,
  16 bytes) → AES-128-CBC with a 16-space IV. For DB schema ≥ 24, verifies and
  strips the 32-byte `SHA256(host_key)` prefix — a mismatch means the wrong
  secret, and the tool says so instead of writing garbage.
- Selects cookies whose host matches a `--domain` (`.yelp.com`,
  `www.yelp.com`, `business.yelp.com`, …), converts Chrome's timestamps and
  `samesite` codes to Playwright's format, and **merges into the output
  file** (replacing only those domains), so jars for several sites can be
  built up over time.
- Writes the file mode `600` and prints the copy one-liner below.

### 5. Delivery

```
cat cookies.json | ssh docker 'docker exec -i webfetch sh -c "cat > /data/cookies.json && chmod 600 /data/cookies.json"'
```

No `sudo` (the stack's `./data` is root-owned, but the user is in the `docker`
group), no temp copy on the VM, no restart (hot reload). `./data` survives
Komodo redeploys.

## Security

The jar contains live session cookies for the exported domains — potentially a
logged-in account. It lives only in `/data` (mode `600`), is never logged, is
not exposed through any API, and write-back only touches domains already in
it. The export tool only pulls the named domains. The keyring secret is read
at export time and never stored. The service remains LAN-only; the
never-expose-port-9001-externally rule matters more now, since the browser
carries real cookies.

## Configuration

- `WEBFETCH_COOKIE_JAR` — jar path (default `/data/cookies.json`).

## Testing

- `cookie-jar.test.ts` — load/missing/malformed file, mtime hot reload,
  domain derivation, merge rules (jar domains only, replace by key, drop
  expired), atomic mode-`600` write, concurrent merges serialized.
- `export-cookies.test.ts` — decrypt a synthetic Chrome `Cookies` DB fixture
  built with a known secret (schema ≥ 24 prefix, `v10`/`v11`), wrong-secret
  detection, domain matching, timestamp/`sameSite` conversion, merge into an
  existing jar.
- `detect-block.test.ts` — DataDome challenge fixture, 403/429 near-empty
  bodies, real pages that mention "captcha" but aren't walls.
- `BrowserManager` — cookies injected on context create and merged back on
  close (fake context).
- `fetch_page` — empty browser content returns an error (REST `502`); stale-jar
  message when the domain is in the jar; `blocked` field on the session
  envelope.
- Gated integration (`YELP_INTEGRATION=1` and a jar present) — real Yelp biz +
  search through `fetch_page` and a session, via Camoufox + jar.

## Rollout

A `feat:` change → release-please cuts `0.5.0`. After the proxmox agent
deploys it: run the export on the desktop, copy the jar in, and verify Yelp
biz + search through `http://webfetch.home`. The README gets a "Sites behind
bot protection" section covering export, delivery, and what a stale-jar error
means.
