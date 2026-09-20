# HTTP browse sessions — design

**Status:** approved design, pre-implementation
**Date:** 2026-09-20

## Goal

Expose webfetch's existing interactive-browsing capability over HTTP, with an
explicit session lifecycle, so a non-MCP client — primarily an LLM agent such
as raven-rs — can drive a real browser step by step: open a page, read an
accessibility snapshot, click/type by role+name, and repeat across requests.

Today the REST face (`src/server.ts`) only offers one-shot `POST /fetch`. The
interactive surface exists only over MCP (`src/standalone.ts`). This adds a
first-class HTTP session API for that surface.

## Non-goals

- No new authentication. The service stays LAN-only behind nginx-proxy-manager,
  same as `/fetch`.
- No session persistence across process restarts. Sessions are in-memory; a
  redeploy (our normal ship path) drops them. Clients treat a `404` on a
  session id as "recreate".
- No scraped-automation/DOM-selector API. The vocabulary is the accessibility
  snapshot (role + name), matching how the MCP side already works.
- No LRU eviction of live sessions. Over the concurrency cap we return `429`;
  the only automatic close is the idle TTL.

## Context / existing assets

- `BrowserManager` (`src/browser-manager.ts`) already manages sessions:
  `getSession(id)` get-or-creates an isolated `BrowserContext` + `Page`;
  `closeSession(id)` / `close()` tear down. Backed by one Camoufox (Firefox)
  process shared by all sessions.
- The MCP tools (`src/tools.ts`) already implement the browse operations
  (`browse_navigate` / `browse_snapshot` / `browse_click` / `browse_type` /
  `browse_scroll` / `browse_go_back` / `browse_select_option` /
  `browse_press_key`), keyed by `agentName:channelId`.
- `takeSnapshot` (`src/snapshot.ts`) returns Playwright's `ariaSnapshot()` — a
  YAML-like accessibility tree whose interactive nodes carry a role + accessible
  name that map directly to `getByRole(role, { name })`.
- The deployed image runs only the REST server (`dist/server.js`), so the
  concurrency cap here governs the one browser process that matters in prod. The
  MCP `standalone.ts` is a separate dev/bench process with its own browser.

## Hardware constraint (drives the limits)

The deploy VM is ~9.7 GB RAM, **no swap**, container `mem_limit: 2g`. Each open
session is a live browser context holding a page. Sessions must be tightly
bounded.

## Approach

Extract the per-operation browse logic out of the MCP tool handlers into one
shared module, `BrowseController` (`src/browse.ts`). Both faces become thin
adapters over it:

- MCP tools (`tools.ts`) delegate to `BrowseController` (small refactor).
- New HTTP session routes call `BrowseController` after resolving the session,
  and add the lifecycle (create / cap / TTL / close) via a new `SessionManager`.

This keeps one source of truth for browse semantics, makes each piece testable
in isolation, and keeps the two faces from drifting.

## API surface

Same `server.ts` process and the same single `BrowserManager` as `/fetch`.
Verb-per-path under `/sessions`, mirroring the MCP tool names. **Every
operation returns the same envelope** so the agent always sees current state:

```json
{ "url": "<current url>", "title": "<page title>", "snapshot": "<aria tree>" }
```

| Method + path                 | Body                              | Success                             |
| ----------------------------- | --------------------------------- | ----------------------------------- |
| `POST /sessions`              | —                                 | `201 { session_id, expires_in_ms }` |
| `POST /sessions/:id/navigate` | `{ url, wait_for?, timeout_ms? }` | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/snapshot` | —                                 | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/click`    | `{ role, name }`                  | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/type`     | `{ role, name, text, submit? }`   | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/scroll`   | `{ direction, amount? }`          | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/back`     | —                                 | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/select`   | `{ role, name, values[] }`        | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/press`    | `{ key }`                         | `200 { url, title, snapshot }`      |
| `POST /sessions/:id/wait`     | `{ wait_for, timeout_ms? }`       | `200 { url, title, snapshot }`      |
| `DELETE /sessions/:id`        | —                                 | `204`                               |

- `session_id` is a server-generated UUID, carried in the path.
- `wait_for` is `{ role, name }` or `{ text }`.

## Session lifecycle & limits

Owned by a new `SessionManager` (`src/session-manager.ts`) that wraps
`BrowserManager`.

- **Create:** eagerly opens the context+page (so the cap reflects real memory
  and the first navigate is instant). Enforces a concurrency cap
  `WEBFETCH_MAX_SESSIONS` (default **3**); at cap → `429`. Returns id + TTL.
- **Idle TTL:** `WEBFETCH_SESSION_TTL_MS` (default **300000** = 5 min). Every
  operation resets the timer; on expiry the context is closed and evicted.
- **Unknown/expired id:** any operation → `404 { error, hint: "create a new
session" }`.
- **Per-session serialization:** a promise-chain per session so overlapping
  requests to the same page run sequentially (Playwright pages are not
  concurrency-safe).
- **Shutdown:** `SessionManager` clears timers; `BrowserManager.close()` closes
  all contexts (already implemented).

`SessionManager` shape (sketch):

```ts
class SessionManager {
  constructor(bm: BrowserManager, opts: { max: number; ttlMs: number })
  create(): Promise<{ id: string; expiresInMs: number }> // throws SessionCapReached
  run<T>(id: string, fn: (page: Page) => Promise<T>): Promise<T> // throws SessionNotFound; serializes; resets TTL
  close(id: string): Promise<void>
  get size(): number
}
```

## BrowseController interface (`src/browse.ts`)

Pure functions over a Playwright `Page`, each returning `BrowseResult`:

```ts
export interface BrowseResult { url: string; title: string; snapshot: string }
export type WaitFor = { role: string; name: string } | { text: string }

navigate(page, url, opts?: { waitFor?: WaitFor; timeoutMs?: number }): Promise<BrowseResult>
snapshot(page): Promise<BrowseResult>
click(page, role, name): Promise<BrowseResult>
type(page, role, name, text, submit?): Promise<BrowseResult>
scroll(page, direction, amount?): Promise<BrowseResult>
goBack(page): Promise<BrowseResult>
selectOption(page, role, name, values): Promise<BrowseResult>
pressKey(page, key): Promise<BrowseResult>
waitFor(page, waitFor, timeoutMs?): Promise<BrowseResult>
```

- Default settle after navigation stays fast (`domcontentloaded`); condition
  waiting is opt-in via `wait_for`, implemented with Playwright's built-in
  waiting: `{role,name}` → `getByRole(role,{name}).first().waitFor({state:
'visible', timeout})`; `{text}` → `getByText(text).first().waitFor(...)`.
- Actions (`click`/`type`/`select`) rely on Playwright's actionability
  auto-wait, so elements that render in after load are handled without sleeps.
- Role validation moves here (from `tools.ts`), throwing `InvalidRoleError`.
- `rewriteUrl` (existing) is applied in `navigate`, as today.

## Error handling

Typed errors from `BrowseController` / `SessionManager`, mapped uniformly by the
HTTP adapter:

| Condition                                | Status | Body                                                           |
| ---------------------------------------- | ------ | -------------------------------------------------------------- |
| bad/missing body field, invalid role     | `400`  | `{ error, hint? }`                                             |
| unknown/expired session                  | `404`  | `{ error, hint: "create a new session" }`                      |
| session cap reached                      | `429`  | `{ error, hint: "close a session or retry" }`                  |
| element not found / `wait_for` timed out | `502`  | `{ error: 'element not found: role "button" name "Sign in"' }` |
| navigation failed/timed out              | `502`  | `{ error }`                                                    |
| unexpected                               | `500`  | `{ error }`                                                    |

`502` messages include the role+name/text so the agent can re-snapshot and
adjust rather than getting a bare timeout.

## Module layout & refactors

- **New** `src/browse.ts` — `BrowseController` + `WaitFor` + typed errors.
- **New** `src/session-manager.ts` — `SessionManager` (cap, TTL, per-session
  queue, id generation).
- **Refactor** `src/server.ts` — extract a pure `router(deps)` (or
  `handleRequest`) so routing is testable without constructing a browser at
  import time; wire in the session routes alongside `/fetch` and `/health`. The
  current top-level singletons move into a small bootstrap.
- **Refactor** `src/tools.ts` — `browse_*` handlers delegate to
  `BrowseController`; remove the now-duplicated per-op logic and the local role
  table.
- **Docs** — README: new endpoints, the `{url,title,snapshot}` envelope, the
  `wait_for` shape, and the two env vars.

## Config

- `WEBFETCH_MAX_SESSIONS` — max concurrent sessions (default `3`).
- `WEBFETCH_SESSION_TTL_MS` — idle TTL before auto-close (default `300000`).

Both read at startup, alongside existing `PORT` / `WEBFETCH_HEADLESS` /
`WEBFETCH_DB`. Deploy override (if any) is a separate change in the
`homelab-stacks` compose, not in this repo.

## Testing

- `session-manager.test.ts` — cap → `429`/`SessionCapReached`, idle-TTL eviction
  (fake timers), per-session serialization, `close`, unknown-id →
  `SessionNotFound`. Uses a stub `BrowserManager`; no real browser.
- `browse.test.ts` — a mock `Page` asserting the correct Playwright calls and
  the `{url,title,snapshot}` envelope; role validation → `InvalidRoleError`;
  `wait_for` paths. No real browser.
- routing test — the extracted `router` with a stub `SessionManager`: asserts
  the `201/200/204/400/404/429` mapping and body-validation.
- `browse-sessions.integration.test.ts` (gated by env, like the Reddit corpus,
  excluded from `npm test`) — a real Camoufox session: create → navigate
  `example.com` → snapshot contains "Example Domain" → click "Learn more" → url
  changed → close.

## Deployment

No repo/CI changes. Ships via the normal release-tagging flow (conventional
`feat:` → release-please minor bump → tag → `publish-image`). Deploy is the
usual `homelab-stacks` compose pin bump handled by the proxmox/Komodo side; if
non-default limits are wanted, set `WEBFETCH_MAX_SESSIONS` /
`WEBFETCH_SESSION_TTL_MS` there.
