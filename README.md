# webfetch

A small, self-hosted **web-fetch service**. Give it a URL; it returns the page's title and
readable text, choosing the cheapest method that works and falling back to a real stealth
browser when a site needs one.

It began as the `web-access` plugin inside the [raven](https://github.com/) monorepo and was
extracted into its own project. It has **no dependency on raven** — the three small helpers it
used from the monorepo core (`defineTool`, a tiny SQLite migration runner, and a
`PluginDatabase` shape) are vendored in [`src/core-compat.ts`](src/core-compat.ts).

## What it does

For each URL, `fetch_page` runs a tiered strategy and learns per-domain which one works:

1. **Reddit chain** — Reddit walls default user-agents, so Reddit URLs bypass the normal path
   and go through a dedicated chain (per-post Atom feed with the Google FeedFetcher UA →
   `.json` endpoint → `old.reddit.com` → SSR HTML), resolving `/s/` share links first. See
   [`src/reddit.ts`](src/reddit.ts).
2. **Direct HTTP** — a plain `fetch` with a browser UA; the HTML is stripped to text. If the
   result looks blocked or JS-gated (a heuristic), it falls through.
3. **Browser fallback** — [Camoufox](https://github.com/daijro/camoufox), a Firefox fork that
   spoofs its fingerprint at the C++ level, driven via `playwright-core`. Handles JS-heavy and
   anti-bot pages.

Outcomes (success/failure, bytes) are recorded per domain in SQLite, so a domain that keeps
failing direct fetch is routed straight to the browser next time. See
[`src/domain-db.ts`](src/domain-db.ts).

## Two faces

Both wrap the exact same tools ([`src/tools.ts`](src/tools.ts)):

- **REST** ([`src/server.ts`](src/server.ts)) — a one-shot fetch endpoint for simple clients:
  ```
  POST /fetch  { "url": "https://example.com" }
    -> 200 { "title", "text", "final_url", "method" }
    -> 502 { "error", "final_url" }   on a fetch failure
  GET  /health -> 200 { "status": "ok" }
  ```
  It also exposes a session-based browsing surface over REST — see
  [Interactive sessions](#interactive-sessions) below.
- **MCP** ([`src/standalone.ts`](src/standalone.ts)) — a stdio MCP server exposing the full
  interactive browse surface (`fetch_page` plus `browse_navigate` / `browse_snapshot` /
  `browse_click` / `browse_type` / …) for an agent or the browse-bench harness to drive
  multi-step sessions.

## Interactive sessions

For multi-step browsing (navigate, then click, then read the result) `POST /fetch` isn't enough
— each call is a fresh one-shot page load. The `/sessions` routes give a REST client the same
stateful, multi-step browsing the MCP `browse_*` tools give an agent: create a session, then
drive one real browser page across several calls, then close it.

```
POST   /sessions                    -> 201 { "session_id", "expires_in_ms" }
DELETE /sessions/:id                -> 204

POST   /sessions/:id/navigate  { "url", "wait_for"?, "timeout_ms"? }
POST   /sessions/:id/snapshot
POST   /sessions/:id/click     { "role", "name" }
POST   /sessions/:id/type      { "role", "name", "text", "submit"? }
POST   /sessions/:id/scroll    { "direction"?: "up"|"down", "amount"? }
POST   /sessions/:id/back
POST   /sessions/:id/select    { "role", "name", "values": [...] }
POST   /sessions/:id/press     { "key" }
POST   /sessions/:id/wait      { "wait_for", "timeout_ms"? }
```

Every op that touches the page (`navigate`, `snapshot`, `click`, `type`, `scroll`, `back`,
`select`, `press`, `wait`) responds with the same envelope, taken from the page after the op
runs:

```json
{ "url": "https://example.com/", "title": "Example Domain", "snapshot": "- document ..." }
```

The envelope gains an optional `blocked: { reason, hint }` field when the page after the
operation is a detected bot-protection wall (DataDome, Cloudflare, etc.) — see
[Sites behind bot protection](#sites-behind-bot-protection). The call still succeeds (the
`snapshot` is whatever the wall's page is, in case that's useful), but the caller no longer has
to guess from an iframe-only snapshot that something blocked it.

`wait_for` (used by both `navigate`'s optional field and the standalone `wait` op) is one of:

- `{ "role": "...", "name": "..." }` — wait for an element with that accessible role/name to
  appear.
- `{ "text": "..." }` — wait for that text to appear anywhere on the page.

Sessions are capped and expire on their own — see `WEBFETCH_MAX_SESSIONS` and
`WEBFETCH_SESSION_TTL_MS` in [Configuration](#configuration).

Sessions live **in memory only** — a server restart drops them all, and ops against a session
that's gone (expired, closed, or never existed) return `404`. There's no way to recover a lost
session; the client should just create a new one.

Operations on the same session are serialized (one browser page can only do one thing at a
time), but different sessions run independently.

The whole REST surface (this plus `/fetch` and `/health`) is described by an OpenAPI 3.1
document the service serves at `GET /openapi.json`, so a client or agent can discover it at
runtime.

## MCP

The same server also speaks MCP directly, over the network, at:

```
http://webfetch.home/mcp
```

This is the [MCP Streamable HTTP transport](https://modelcontextprotocol.io) — JSON-RPC 2.0
over POST, with an `Mcp-Session-Id` header identifying the client after `initialize` — not a
plain REST resource. `GET /openapi.json` lists `/mcp` too, but only as a pointer: use an MCP
SDK client (`Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`) rather
than calling it directly.

It's the same tool set as the stdio `standalone.ts` server described above — `fetch_page` plus
the full `browse_*` surface (`browse_navigate`, `browse_snapshot`, `browse_click`, `browse_type`,
`browse_scroll`, `browse_go_back`, `browse_select_option`, `browse_press_key`, `browse_wait`) — just reachable
over the network instead of stdio. Each connected MCP client gets its own capped browser session
(`browse_*` calls create it lazily on first use), governed by the same `WEBFETCH_MAX_SESSIONS`
and `WEBFETCH_SESSION_TTL_MS` env vars as `/sessions`.

By default the endpoint only accepts requests whose `Host` header matches the LAN hostnames it's
normally reached at (DNS-rebinding protection); see `WEBFETCH_MCP_ALLOWED_HOSTS` and
`WEBFETCH_MCP_DNS_REBINDING` in [Configuration](#configuration) if it sits behind a reverse proxy.

## Sites behind bot protection

Some sites (Yelp among them) sit behind DataDome-class bot protection that blocks every
browser-automation approach on its own — headless or headed, stealth or not. What gets through
is an **aged cookie jar exported from a real, long-used desktop browser**: injecting those
cookies (including the site's own bot-protection cookie) into a fresh Camoufox context makes it
look like the same trusted visitor who's been browsing the site for months. webfetch does this
automatically for every browser context — `fetch_page`, `/sessions`, and the MCP `browse_*`
tools all share one jar — so once a domain's cookies are in it, it just works.

**Export**, on the desktop where the site already works in a normal Chrome:

```sh
npm run export-cookies -- --domain yelp.com [--domain other.com]
```

This reads Chrome's cookie database directly, so it needs the OS keyring secret Chrome encrypts
cookies with; on Linux that's `secret-tool` (`gnome-keyring` / `libsecret`), which the tool shells
out to automatically. Only the named domains are read and written — nothing else in the browser's
cookie store is touched. Options:

- `--domain D` (repeatable, required) — a site to export; its subdomains are included.
- `--profile DIR` — the Chrome profile to read (default `~/.config/google-chrome/Default`).
- `--out FILE` — the jar to write (default `./cookies.json`, which is gitignored). An existing jar
  is merged: the named domains are replaced, every other domain's cookies are kept. The file is
  always left at mode `600`.
- `--secret-file FILE` — read the keyring secret from a file instead of `secret-tool`, for setups
  without libsecret.

It prints only a per-domain cookie count, never cookie names or values.

**Deliver** the exported file to the running service (the export command prints this exact line
with your paths filled in):

```sh
cat cookies.json | ssh docker 'docker exec -i webfetch sh -c "cat > /data/cookies.json && chmod 600 /data/cookies.json"'
```

No restart needed: the jar is **hot-reloaded** — webfetch stats the file before each new browser
context and re-reads it if it changed, so a copied-in jar takes effect on the very next fetch or
session. Cookies a site rotates during a visit are **written back** to the jar when a context
closes (debounced, atomic, mode `600`), but only for domains the jar already covers — it never
picks up cookies from arbitrary sites the browser happens to visit. Only cookies the context
actually changed are written back, so a session that was open while you re-delivered the jar can't
revert it when it closes, and new session-only cookies aren't persisted.

Point webfetch at a different jar path with `WEBFETCH_COOKIE_JAR` (default `/data/cookies.json`);
a missing file just means an empty jar, not an error.

**When cookies go stale:** a jar's cookies eventually expire or get rotated out from under it. A
`fetch_page` call against a domain the jar covers, that hits a bot wall anyway, fails with a
message naming the site and saying its jar cookies look stale — re-export and re-deliver as
above. The session/MCP `browse_*` envelope carries the same signal as an optional
`blocked: { reason, hint }` field instead of failing the call outright (see
[Interactive sessions](#interactive-sessions)).

**Security:** the jar holds live session cookies for the exported domains — potentially a
logged-in account. It's written mode `600`, no cookie names or values are ever logged or printed
(by the service or the export tool, which prints counts only), and write-back only ever touches
domains already in the jar. The stale-vs-export wording of a block message does tell any caller
of the API whether the jar holds cookies for that site, so it reveals the jar's domain coverage
(never its contents) to LAN callers. Keep webfetch LAN-only — never expose its port externally —
since a browser seeded with real cookies is a more valuable target than a stateless fetcher.

## Run

```sh
npm install
node node_modules/camoufox-js/dist/__main__.js fetch   # one-time: download the Camoufox browser

npm run server        # REST service on :9000  (dev, via tsx)
npm run standalone    # stdio MCP server         (dev, via tsx)

npm run build         # compile to dist/
npm test              # unit tests (reddit parsing / block detection / routes / sessions)

npm run test:integration          # live Reddit fetches (needs network; REDDIT_INTEGRATION=1)
npm run test:integration:browse   # live session API against a real Camoufox (BROWSE_INTEGRATION=1)
npm run test:integration:mcp      # live /mcp endpoint against a real Camoufox (MCP_INTEGRATION=1)
npm run test:integration:yelp     # live Yelp via the cookie jar (YELP_INTEGRATION=1, needs a jar)
```

### Docker

```sh
docker build -t webfetch .
docker run -p 9000:9000 webfetch
curl -s localhost:9000/fetch -d '{"url":"https://example.com"}' | jq
```

The image downloads Camoufox at build time and runs under `xvfb`, so it is large and slow to
build. The system-lib set in the [`Dockerfile`](Dockerfile) is best-effort for Camoufox and may
need a tweak on a first real build.

## Configuration

| Env var                      | Default              | Meaning                                                                                   |
| ---------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`                       | `9000`               | REST listen port.                                                                         |
| `WEBFETCH_DB`                | `:memory:`           | SQLite path for the per-domain method-learning store.                                     |
| `WEBFETCH_HEADLESS`          | `true`               | Set `false` to launch Camoufox headed (local debugging).                                  |
| `WEBFETCH_MAX_SESSIONS`      | `3`                  | Max concurrent `/sessions`; `POST /sessions` past the cap is `429`.                       |
| `WEBFETCH_SESSION_TTL_MS`    | `300000`             | Idle timeout (ms) for a session; each op resets the timer.                                |
| `WEBFETCH_MCP_ALLOWED_HOSTS` | LAN hostnames        | Comma-separated `Host` values `/mcp` accepts (DNS-rebinding protection).                  |
| `WEBFETCH_MCP_DNS_REBINDING` | `true`               | Set `false`/`0` to disable the `/mcp` Host check (e.g. behind a reverse proxy).           |
| `WEBFETCH_COOKIE_JAR`        | `/data/cookies.json` | Path to the cookie jar (see [Sites behind bot protection](#sites-behind-bot-protection)). |
