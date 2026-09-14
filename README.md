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
- **MCP** ([`src/standalone.ts`](src/standalone.ts)) — a stdio MCP server exposing the full
  interactive browse surface (`fetch_page` plus `browse_navigate` / `browse_snapshot` /
  `browse_click` / `browse_type` / …) for an agent or the browse-bench harness to drive
  multi-step sessions.

## Run

```sh
npm install
node node_modules/camoufox-js/dist/__main__.js fetch   # one-time: download the Camoufox browser

npm run server        # REST service on :9000  (dev, via tsx)
npm run standalone    # stdio MCP server         (dev, via tsx)

npm run build         # compile to dist/
npm test              # unit tests (reddit parsing / block detection)
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

| Env var             | Default    | Meaning                                                  |
| ------------------- | ---------- | -------------------------------------------------------- |
| `PORT`              | `9000`     | REST listen port.                                        |
| `WEBFETCH_DB`       | `:memory:` | SQLite path for the per-domain method-learning store.    |
| `WEBFETCH_HEADLESS` | `true`     | Set `false` to launch Camoufox headed (local debugging). |
