# Networked MCP endpoint — design

**Status:** approved design, pre-implementation
**Date:** 2026-09-21

## Goal

Let a networked agent use webfetch over MCP — `fetch_page` plus the interactive
`browse_*` surface — **without deploying anything new** and **without running a
local browser**. Achieved by adding an MCP endpoint to the existing webfetch
process, served over the MCP Streamable-HTTP transport at `POST/GET/DELETE
/mcp`, reachable through the existing `webfetch.home` route.

## Non-goals

- No separate MCP service/container (e.g. an `mcp-bridge`); the whole point is
  no new deployment. The endpoint rides in the existing image.
- No new auth. LAN-only behind nginx-proxy-manager, same as `/fetch` and
  `/sessions`. (DNS-rebinding protection is configured — see Security — but
  that is not user auth.)
- No change to the stdio `standalone.ts` behavior beyond refactoring it onto a
  shared server factory and gaining the new `browse_wait` tool / `wait_for`
  option (see Tool surface); it stays a local, single-session, self-contained
  MCP server for offline/dev use.

## Context / existing assets

- `standalone.ts` is a stdio MCP `Server` that registers `ListTools`/`CallTool`
  over `createTools(browserManager, domainDb)` and connects a
  `StdioServerTransport`. Its `CallTool` passes a minimal ctx, so all browse
  calls share one default `BrowserManager` session.
- `@modelcontextprotocol/sdk@1.30.0` ships `StreamableHTTPServerTransport`
  (`server/streamableHttp.js`) with options `sessionIdGenerator`,
  `onsessioninitialized`, `onsessionclosed`, `enableJsonResponse`,
  `allowedHosts`/`allowedOrigins`, `enableDnsRebindingProtection`, and
  `handleRequest(req, res, parsedBody?)`. `isInitializeRequest` is exported from
  `types.js`.
- REST face: `createRouter(deps)` in `routes.ts` already serves `/fetch`,
  `/health`, `/openapi.json`, and `/sessions/*`. `SessionManager` governs
  browser sessions (cap → 429, idle TTL, per-session serialization);
  `BrowseController` (`browse.ts`) is the shared browse logic; `runOp` in
  `routes.ts` maps an op name + body → a `BrowseController` call.
- The deployed image runs only `dist/server.js` (the REST process). Adding the
  MCP endpoint there is what makes it network-reachable with no new deploy.

## Hardware constraint

Same 2 GB / no-swap VM. MCP-driven browser contexts must be bounded — they draw
from the **same `SessionManager` cap** as REST sessions.

## Architecture

Mount an MCP Streamable-HTTP endpoint on the existing `node:http` server. One
process, one Camoufox, three faces: REST, MCP-over-HTTP, and the untouched
stdio `standalone.ts`.

Request flow at `/mcp`, delegated to an `McpFace`:

- `POST /mcp` with an **initialize** body (no `Mcp-Session-Id`): create a
  `StreamableHTTPServerTransport` (with `sessionIdGenerator: randomUUID`), create
  an MCP `Server`, `server.connect(transport)`, register the transport in a map
  keyed by the generated session id (via `onsessioninitialized`), then
  `transport.handleRequest(req, res, body)`.
- `POST /mcp` with `Mcp-Session-Id`: look up the transport → `handleRequest`.
- `GET /mcp`: the server→client SSE stream → `handleRequest`.
- `DELETE /mcp`: terminate → `handleRequest`; `onsessionclosed` closes that
  client's browse session.
- Unknown/missing session id on a non-initialize request → JSON-RPC error / 404.

`McpFace` holds `Map<mcpSessionId, { transport; server; browseSessionId?: string }>`.

## Session mapping (per-client, capped)

Each MCP client's browser context **is a `SessionManager` session**:

- Created **lazily** on that client's first `browse_*` call (not on MCP
  initialize — a client that only calls `fetch_page` never opens a browser
  page), via `sessions.create()`, and its id stored on the map entry.
- All that client's `browse_*` ops run through
  `sessions.run(browseSessionId, page => …)`, inheriting the cap, idle TTL, and
  per-session serialization.
- If `create()` throws `SessionCapReached`, the tool call returns an error
  result ("session cap reached — retry"); the memory bound holds.
- On a `SessionNotFound` (the browse session was idle-evicted mid-MCP-session),
  the face transparently re-creates one and retries once.
- `onsessionclosed` (DELETE or transport teardown) → `sessions.close(browseSessionId)`.

This reuses the REST face's governance with no second code path.

## Tool surface & dispatch

The same tool set on both MCP faces (stdio and HTTP) — the current tools plus
condition-based waiting (see v1 tool surface below):

- **`ListTools`** — from the `createTools(...)` declarations: `fetch_page`,
  `browse_navigate`, `browse_snapshot`, `browse_click`, `browse_type`,
  `browse_scroll`, `browse_go_back`, `browse_select_option`,
  `browse_press_key`, and `browse_wait` (names, descriptions, zod input
  schemas).
- **`CallTool`:**
  - `fetch_page` → the existing one-shot `fetch_page` handler (not session-bound).
  - `browse_*` → mapped to the matching `BrowseController` op and executed via
    `sessions.run(thisClientsBrowseSession, …)`. Argument validation reuses the
    tool's zod schema.
  - Result shaping: `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`,
    matching the stdio server. Tool errors return an error result, not a
    protocol error.

**Shared factory.** Extract `createMcpServer({ toolDeclarations, callTool })`
that wires `ListTools` + `CallTool` on an MCP `Server`. Both faces use it:

- stdio `standalone.ts` injects a `callTool` that runs `fetch_page` via the tool
  handler and `browse_*` against a single default `BrowserManager` session
  (current behavior preserved).
- the HTTP `McpFace` injects a `callTool` that runs `browse_*` through
  `SessionManager` keyed by the MCP session.

Only the browse-execution strategy differs; the protocol wiring and tool list
are shared.

### v1 tool surface: condition-based waiting included

v1 brings the MCP surface to parity with the REST `/sessions` API on
condition-based waiting, since this endpoint exists for JS-heavy interactive
browsing:

- **`browse_navigate`** gains optional `wait_for` and `timeout_ms` params,
  mapping to `BrowseController.navigate(page, url, { waitFor, timeoutMs })`.
- A new **`browse_wait`** tool (`{ wait_for, timeout_ms? }`) maps to
  `BrowseController.waitFor(page, waitFor, timeoutMs)`.
- `wait_for` is the same `{ role, name } | { text }` shape as REST, expressed as
  a zod union in the tool schema and validated the same way (a present-but-empty
  `text` is rejected; reuse the REST `validateWaitFor` logic rather than
  duplicating it).

These are added to the shared `createTools` declarations, so **both** the stdio
server and the HTTP MCP face gain them together — keeping the two MCP faces
identical and consistent with REST. (`timeout_ms` is clamped to the same 60000
ceiling the REST face uses.)

## Security

LAN-only, no auth (consistent with the rest of the service). The transport
offers **DNS-rebinding protection** (`enableDnsRebindingProtection` +
`allowedHosts`/`allowedOrigins`) to stop a LAN browser being tricked
cross-origin into driving the endpoint — relevant because MCP can navigate a
real browser to internal hosts.

**Caveat to verify during implementation:** DNS-rebinding protection validates
the `Host` header against `allowedHosts`. Behind nginx-proxy-manager the node
server sees whatever Host NPM forwards, not necessarily `webfetch.home`, so a
wrong `allowedHosts` would break the proxied endpoint. The implementer must
confirm the forwarded Host (the direct-vs-proxied value) and set `allowedHosts`
to match (e.g. `webfetch.home`, `127.0.0.1:9000`, `localhost:9000`) — and if the
proxied Host turns out to be unpredictable, make protection configurable
(default on with the known hosts, an env escape hatch to disable) rather than
hard-break the LAN deployment, since exposure is already LAN-only. The
never-expose-port-9001-externally rule is the primary control and is carried as
a note to `homelab-stacks`.

## Module layout

- **New** `src/mcp-server.ts` — `createMcpServer({ toolDeclarations, callTool })`
  returning a configured MCP `Server` (protocol wiring only; browse execution
  injected).
- **New** `src/mcp-http.ts` — `McpFace`: the transport map, initialize/lookup,
  the `SessionManager`-keyed `callTool`, lazy browse-session create + retry, and
  cleanup. Exposes a `handle(req, res)` the router calls, and a `closeAll()` for
  shutdown.
- **Modify** `src/routes.ts` — add the `/mcp` route (POST/GET/DELETE) delegating
  to `McpFace.handle`; `RouterDeps` gains `mcp: McpFace`.
- **Modify** `src/server.ts` — construct the `McpFace` (with `browserManager`,
  `sessions`, the tool declarations) and pass it into `createRouter`; close it
  on shutdown.
- **Modify** `src/tools.ts` — add the `browse_wait` tool and optional
  `wait_for`/`timeout_ms` params on `browse_navigate` (mapping to
  `BrowseController.waitFor` / `navigate`'s `waitFor` option). Share the
  `wait_for` shape validation with the REST face (extract `validateWaitFor` to a
  common spot rather than duplicating it in `routes.ts` and `tools.ts`).
- **Modify** `src/standalone.ts` — build its `Server` via `createMcpServer` with
  the default-session `callTool` (behavior preserved; it also gains the new
  `browse_wait` tool automatically via the shared declarations).
- **Modify** `src/openapi.ts` — a short `/mcp` path stub noting it's an MCP
  Streamable-HTTP endpoint, not a REST resource (so the OpenAPI doc acknowledges
  the port speaks MCP too).
- **Modify** `README.md` — document the MCP endpoint, its URL, and the tool set.

## Testing

- `mcp-server.test.ts` — the shared factory: `ListTools` returns the expected
  tool declarations (including `browse_wait`); `CallTool` dispatches to the
  injected `callTool` and shapes the result/error. Uses a stub `callTool`; no
  browser.
- `tools` coverage — `browse_wait` and `browse_navigate`'s `wait_for` map to the
  right `BrowseController` calls, and a malformed `wait_for` is rejected (shared
  `validateWaitFor`).
- `mcp-http.test.ts` — the `McpFace` browse dispatch and session mapping with a
  **stub `SessionManager`** (like `routes.test`): a `browse_*` call lazily
  creates a browse session and runs the op; `SessionCapReached` → error result;
  `SessionNotFound` → one transparent re-create + retry; `onsessionclosed`
  closes the browse session.
- MCP handshake test — using the SDK's `Client` + an in-memory/loopback
  transport pair (or `StreamableHTTPClientTransport` against the in-process
  `http` server): `initialize` + `listTools` returns the expected tools. No
  browser needed.
- `mcp.integration.test.ts` (gated by env, like the browser corpus, excluded
  from `npm test`) — a real end-to-end over `StreamableHTTPClientTransport`
  against an in-process server with a real `BrowserManager`: `initialize` →
  `callTool fetch_page` (or a `browse_navigate` snapshot) succeeds.

## Deployment

No repo/CI changes. Ships via the normal release-tagging flow (a `feat:` →
minor bump). No new env vars required (the browser/session env already exists).
Deploy is the usual `homelab-stacks` pin bump; add the LAN-only note there.
The endpoint becomes reachable at `http://webfetch.home/mcp`.
