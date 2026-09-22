# Networked MCP Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve webfetch's tools (`fetch_page` + interactive `browse_*`, including condition-based `wait_for`) to networked agents over an MCP Streamable-HTTP endpoint mounted on the existing server — no new deployment, no local browser.

**Architecture:** Add `POST/GET/DELETE /mcp` to the existing `node:http` router via the MCP SDK's `StreamableHTTPServerTransport`. A shared `createMcpServer` factory backs both the stdio `standalone.ts` and the new HTTP face. Each HTTP MCP client's browser context is a `SessionManager` session (same cap/idle-TTL/serialization as REST `/sessions`). Browse-tool semantics live in one shared `callBrowseTool` used by every face.

**Tech Stack:** TypeScript (TS 7), Node `node:http`, `@modelcontextprotocol/sdk@1.30.0` (`StreamableHTTPServerTransport`, `Server`, `Client`), `playwright-core`, `zod`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-09-21-mcp-http-endpoint-design.md`

## Global Constraints

- **No new deps** — `@modelcontextprotocol/sdk` and `zod` are already present; do not add packages.
- **Prettier** (`.prettierrc`): `singleQuote: true`, `semi: false`, `printWidth: 100`. Run `npx prettier --write` on changed files before committing.
- **Lint** `npm run lint` (oxlint) and **typecheck** `npm run typecheck` (`tsc --noEmit`, TS 7) must be clean.
- **ESM**: relative imports use the `.js` extension.
- **Acronym casing**: capitalize only the first letter of multi-letter acronyms in new identifiers (`Url`, `Mcp`, `Http` — e.g. `McpFace`, `mcpHttp`).
- **Commit trailer**: end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (exact model name).
- **`wait_for` shape**: `{ role: string, name: string } | { text: string }`; a present-but-empty `text` is rejected. **One** `validateWaitFor` shared by REST and the MCP tools.
- **`timeout_ms`** clamps to a 60000 ceiling (as REST does).
- **MCP tool result shape**: `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`. Tool-level failures return an error _result_ (`isError: true`), not a JSON-RPC protocol error.

## File Structure

- **Create** `src/browse-tools.ts` — `validateWaitFor` (moved from `routes.ts`), `BROWSE_TOOL_OPS` (MCP tool name → op), and `callBrowseTool(name, args, run)`: validate args, dispatch to `BrowseController`, return the `{url,title,snapshot}` envelope. Single source of browse-tool semantics.
- **Create** `src/browse-tools.test.ts`.
- **Create** `src/mcp-server.ts` — `createMcpServer({ toolDeclarations, callTool })`: wires `ListTools`/`CallTool` on an MCP `Server`.
- **Create** `src/mcp-server.test.ts`.
- **Create** `src/mcp-http.ts` — `McpFace`: transport map, session lifecycle, per-client `SessionManager` browse session, `callTool` routing, `handle(req,res)`, `closeAll()`.
- **Create** `src/mcp-http.test.ts`.
- **Create** `src/mcp.integration.test.ts` — gated (`MCP_INTEGRATION=1`) real end-to-end.
- **Modify** `src/tools.ts` — `browse_*` handlers delegate to `callBrowseTool`; add `browse_wait` tool and optional `wait_for`/`timeout_ms` on `browse_navigate`.
- **Modify** `src/routes.ts` — import `validateWaitFor` from `browse-tools.js`; add the `/mcp` route delegating to `McpFace`; `RouterDeps` gains `mcp`.
- **Modify** `src/server.ts` — construct `McpFace`, pass to `createRouter`, close on shutdown.
- **Modify** `src/standalone.ts` — build its `Server` via `createMcpServer`.
- **Modify** `src/openapi.ts` — a short `/mcp` path note (MCP endpoint, not a REST resource).
- **Modify** `README.md` — document the MCP endpoint.
- **Modify** `package.json` — add `test:integration:mcp`.

---

### Task 1: Shared browse-tool dispatch + `wait_for`/`browse_wait` (`src/browse-tools.ts`, `src/tools.ts`)

**Files:**

- Create: `src/browse-tools.ts`, `src/browse-tools.test.ts`
- Modify: `src/tools.ts`, `src/routes.ts` (import `validateWaitFor` from the new module)

**Interfaces:**

- Consumes: `* as browse` from `./browse.js` (`BrowseResult`, `WaitFor`, ops); `Page` from `playwright-core`.
- Produces:
  - `validateWaitFor(wf: unknown): browse.WaitFor` (throws `BrowseArgError` on bad shape)
  - `class BrowseArgError extends Error`
  - `const BROWSE_TOOL_OPS: Record<string, string>` — MCP tool name → internal op (`browse_navigate`→`navigate`, `browse_go_back`→`back`, `browse_select_option`→`select`, `browse_press_key`→`press`, `browse_wait`→`wait`, else strip `browse_`).
  - `type RunOnPage = <T>(fn: (page: Page) => Promise<T>) => Promise<T>`
  - `callBrowseTool(toolName: string, args: Record<string, unknown>, run: RunOnPage): Promise<browse.BrowseResult>`

- [ ] **Step 1: Write the failing test** (`src/browse-tools.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest'
import { callBrowseTool, validateWaitFor, BrowseArgError } from './browse-tools.js'

function mockPage() {
  const loc = {
    first() {
      return this
    },
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    ariaSnapshot: vi.fn(async () => '- doc'),
  }
  return {
    goto: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    url: () => 'https://example.com/',
    title: async () => 'Example',
    locator: () => loc,
    getByRole: vi.fn(() => loc),
    getByText: vi.fn(() => loc),
    mouse: { wheel: vi.fn(async () => {}) },
    keyboard: { press: vi.fn(async () => {}) },
    _loc: loc,
  }
}

const runWith = (page: unknown) => (fn: (p: never) => Promise<unknown>) => fn(page as never)

describe('validateWaitFor', () => {
  it('accepts {text} and {role,name}, rejects empty text and non-objects', () => {
    expect(validateWaitFor({ text: 'Hi' })).toEqual({ text: 'Hi' })
    expect(validateWaitFor({ role: 'button', name: 'Go' })).toEqual({ role: 'button', name: 'Go' })
    expect(() => validateWaitFor({ text: '' })).toThrow(BrowseArgError)
    expect(() => validateWaitFor('x')).toThrow(BrowseArgError)
  })
})

describe('callBrowseTool', () => {
  it('browse_navigate returns the envelope and passes wait_for through', async () => {
    const page = mockPage()
    const r = await callBrowseTool(
      'browse_navigate',
      { url: 'https://example.com', wait_for: { text: 'Example' } },
      runWith(page),
    )
    expect(page.goto).toHaveBeenCalled()
    expect(page.getByText).toHaveBeenCalledWith('Example')
    expect(r).toEqual({ url: 'https://example.com/', title: 'Example', snapshot: '- doc' })
  })

  it('browse_wait waits on a role+name locator', async () => {
    const page = mockPage()
    await callBrowseTool('browse_wait', { wait_for: { role: 'button', name: 'Go' } }, runWith(page))
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Go' })
    expect(page._loc.waitFor).toHaveBeenCalled()
  })

  it('browse_click validates required fields', async () => {
    const page = mockPage()
    await expect(callBrowseTool('browse_click', {}, runWith(page))).rejects.toBeInstanceOf(
      BrowseArgError,
    )
  })

  it('browse_wait rejects a missing wait_for', async () => {
    const page = mockPage()
    await expect(callBrowseTool('browse_wait', {}, runWith(page))).rejects.toBeInstanceOf(
      BrowseArgError,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browse-tools.test.ts`
Expected: FAIL — `browse-tools.js` does not exist.

- [ ] **Step 3: Write `src/browse-tools.ts`**

Move `validateWaitFor` out of `routes.ts` (renaming its thrown `BadRequest` to a local `BrowseArgError`), and implement the dispatch. `timeout_ms` clamps to 60000; `amount`/`timeout_ms` must be finite numbers if present.

```ts
import type { Page } from 'playwright-core'
import * as browse from './browse.js'

export class BrowseArgError extends Error {}

const MAX_TIMEOUT_MS = 60000

function needStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0)
    throw new BrowseArgError(`"${key}" string is required`)
  return v
}

export function validateWaitFor(wf: unknown): browse.WaitFor {
  if (!wf || typeof wf !== 'object')
    throw new BrowseArgError('"wait_for" must be {text} or {role,name}')
  const w = wf as { text?: unknown; role?: unknown; name?: unknown }
  if ('text' in w) {
    if (typeof w.text !== 'string' || w.text.length === 0)
      throw new BrowseArgError('"wait_for.text" must be a non-empty string')
    return { text: w.text }
  }
  if (typeof w.role !== 'string' || w.role.length === 0 || typeof w.name !== 'string')
    throw new BrowseArgError('"wait_for" must be {text} or {role,name}')
  return { role: w.role, name: w.name }
}

function optWaitFor(args: Record<string, unknown>): browse.WaitFor | undefined {
  return args.wait_for === undefined ? undefined : validateWaitFor(args.wait_for)
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new BrowseArgError(`"${key}" must be a number`)
  return v
}

function optTimeout(args: Record<string, unknown>): number | undefined {
  const v = optNum(args, 'timeout_ms')
  return v === undefined ? undefined : Math.min(v, MAX_TIMEOUT_MS)
}

export const BROWSE_TOOL_OPS: Record<string, string> = {
  browse_navigate: 'navigate',
  browse_snapshot: 'snapshot',
  browse_click: 'click',
  browse_type: 'type',
  browse_scroll: 'scroll',
  browse_go_back: 'back',
  browse_select_option: 'select',
  browse_press_key: 'press',
  browse_wait: 'wait',
}

export type RunOnPage = <T>(fn: (page: Page) => Promise<T>) => Promise<T>

export function callBrowseTool(
  toolName: string,
  args: Record<string, unknown>,
  run: RunOnPage,
): Promise<browse.BrowseResult> {
  const op = BROWSE_TOOL_OPS[toolName]
  switch (op) {
    case 'navigate':
      return run((p) =>
        browse.navigate(p, needStr(args, 'url'), {
          waitFor: optWaitFor(args),
          timeoutMs: optTimeout(args),
        }),
      )
    case 'snapshot':
      return run((p) => browse.snapshot(p))
    case 'click':
      return run((p) => browse.click(p, needStr(args, 'role'), needStr(args, 'name')))
    case 'type':
      return run((p) =>
        browse.type(
          p,
          needStr(args, 'role'),
          needStr(args, 'name'),
          needStr(args, 'text'),
          args.submit === true,
        ),
      )
    case 'scroll':
      return run((p) =>
        browse.scroll(p, args.direction === 'up' ? 'up' : 'down', optNum(args, 'amount')),
      )
    case 'back':
      return run((p) => browse.goBack(p))
    case 'select': {
      const values = args.values
      if (!Array.isArray(values) || values.length === 0)
        throw new BrowseArgError('"values" array is required')
      return run((p) =>
        browse.selectOption(p, needStr(args, 'role'), needStr(args, 'name'), values as string[]),
      )
    }
    case 'press':
      return run((p) => browse.pressKey(p, needStr(args, 'key')))
    case 'wait':
      return run((p) => browse.waitFor(p, validateWaitFor(args.wait_for), optTimeout(args)))
    default:
      throw new BrowseArgError(`unknown browse tool "${toolName}"`)
  }
}
```

- [ ] **Step 4: Refactor `src/tools.ts` to use `callBrowseTool`, add the wait tools**

For every existing `browse_*` tool, replace the handler body with a delegation that returns the envelope. The `run` obtains the page from the session the tool already used (`browserManager.getSession(getRunId(ctx))`). Add `wait_for`/`timeout_ms` to `browse_navigate`'s zod params, and add a new `browse_wait` tool. Use a zod union for `wait_for`:

```ts
import { callBrowseTool } from './browse-tools.js'

const waitForParam = z
  .union([
    z.object({ role: z.string(), name: z.string() }),
    z.object({ text: z.string() }),
  ])
  .optional()
  .describe('Wait until an element by role+name, or text, appears.')

// browse_navigate params:
params: z.object({
  url: z.string().describe('The URL to navigate to'),
  wait_for: waitForParam,
  timeout_ms: z.number().optional(),
}),
async handler(params, ctx) {
  const run = async <T,>(fn: (p: import('playwright-core').Page) => Promise<T>) =>
    fn((await browserManager.getSession(getRunId(ctx))).page)
  return callBrowseTool('browse_navigate', params as Record<string, unknown>, run)
},
```

Apply the same delegation shape to `browse_snapshot`/`click`/`type`/`scroll`/`go_back`/`select_option`/`press_key`, and add a `browse_wait` tool (`params: z.object({ wait_for: <required union>, timeout_ms: z.number().optional() })`, delegating to `callBrowseTool('browse_wait', ...)`). Every browse tool now returns `{url,title,snapshot}`.

Then in `src/routes.ts`, delete the local `validateWaitFor` and import it from `./browse-tools.js` (keep `runOp` otherwise unchanged; it still calls `validateWaitFor(body.wait_for)`).

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `npx vitest run src/browse-tools.test.ts && npm run typecheck && npm run lint && npm test`
Expected: new tests pass; **full suite green** — `routes.test.ts` still passes (validateWaitFor now imported), `browse.test.ts` unchanged. Note: MCP browse tool return shapes are now the uniform envelope by design.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/browse-tools.ts src/browse-tools.test.ts src/tools.ts src/routes.ts
git add src/browse-tools.ts src/browse-tools.test.ts src/tools.ts src/routes.ts
git commit -m "$(printf 'feat: shared browse-tool dispatch; add browse_wait and navigate wait_for\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: MCP server factory (`src/mcp-server.ts`) + refactor `standalone.ts`

**Files:**

- Create: `src/mcp-server.ts`, `src/mcp-server.test.ts`
- Modify: `src/standalone.ts`

**Interfaces:**

- Consumes: `Server` from `@modelcontextprotocol/sdk/server/index.js`; `CallToolRequestSchema`, `ListToolsRequestSchema` from `@modelcontextprotocol/sdk/types.js`; `ToolDeclaration` from `./core-compat.js`.
- Produces:
  - `type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>`
  - `createMcpServer(opts: { toolDeclarations: ToolDeclaration[]; callTool: ToolCaller; name?: string; version?: string }): Server`

- [ ] **Step 1: Write the failing test** (`src/mcp-server.test.ts`)

Drive the `Server` through an in-memory linked transport pair so no HTTP/stdio is needed.

```ts
import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './mcp-server.js'
import type { ToolDeclaration } from './core-compat.js'

const decls: ToolDeclaration[] = [
  {
    name: 'fetch_page',
    description: 'fetch',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({}),
  },
  {
    name: 'browse_wait',
    description: 'wait',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({}),
  },
]

async function connect(callTool: (n: string, a: Record<string, unknown>) => Promise<unknown>) {
  const server = createMcpServer({ toolDeclarations: decls, callTool })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(c)
  return client
}

describe('createMcpServer', () => {
  it('lists the tool declarations', async () => {
    const client = await connect(async () => ({}))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['browse_wait', 'fetch_page'])
  })

  it('routes callTool and wraps the result as text content', async () => {
    const client = await connect(async (name, args) => ({ echoed: name, args }))
    const res = await client.callTool({ name: 'fetch_page', arguments: { url: 'u' } })
    expect(JSON.parse((res.content as { type: string; text: string }[])[0].text)).toEqual({
      echoed: 'fetch_page',
      args: { url: 'u' },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server.test.ts`
Expected: FAIL — `mcp-server.js` does not exist. (If `@modelcontextprotocol/sdk/inMemory.js` is not the correct path in 1.30.0, find the InMemoryTransport export path under `node_modules/@modelcontextprotocol/sdk/dist/esm/` and use it.)

- [ ] **Step 3: Write `src/mcp-server.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDeclaration } from './core-compat.js'

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>

export function createMcpServer(opts: {
  toolDeclarations: ToolDeclaration[]
  callTool: ToolCaller
  name?: string
  version?: string
}): Server {
  const server = new Server(
    { name: opts.name ?? 'webfetch', version: opts.version ?? '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.toolDeclarations.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await opts.callTool(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      )
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true }
    }
  })

  return server
}
```

- [ ] **Step 4: Refactor `src/standalone.ts` to use the factory**

Replace the inline `new Server(...)` + `setRequestHandler` block with `createMcpServer`, injecting a `callTool` that runs the tool declarations' handlers (current behavior — a single default session):

```ts
import { createMcpServer } from './mcp-server.js'
// ...
const byName = new Map(tools.map((t) => [t.name, t]))
const server = createMcpServer({
  toolDeclarations: tools,
  callTool: async (name, args) => {
    const tool = byName.get(name)
    if (!tool) throw new Error(`unknown tool: ${name}`)
    return tool.handler(args, { credentials: {}, fetch: globalThis.fetch } as never)
  },
})
await server.connect(new StdioServerTransport())
```

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `npx vitest run src/mcp-server.test.ts && npm run typecheck && npm run lint && npm test`
Expected: pass. `standalone.ts` compiles and its behavior is unchanged (still lists the same tools, now including `browse_wait` from Task 1).

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/mcp-server.ts src/mcp-server.test.ts src/standalone.ts
git add src/mcp-server.ts src/mcp-server.test.ts src/standalone.ts
git commit -m "$(printf 'refactor: shared createMcpServer factory; standalone uses it\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `McpFace` — HTTP MCP with per-client capped sessions (`src/mcp-http.ts`)

**Files:**

- Create: `src/mcp-http.ts`, `src/mcp-http.test.ts`

**Interfaces:**

- Consumes: `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`; `isInitializeRequest` from `@modelcontextprotocol/sdk/types.js`; `createMcpServer`/`ToolCaller` from `./mcp-server.js`; `callBrowseTool`, `BROWSE_TOOL_OPS`, `BrowseArgError` from `./browse-tools.js`; `SessionManager`, `SessionNotFound`, `SessionCapReached` from `./session-manager.js`; a `fetch_page` `ToolDeclaration`.
- Produces:
  - `class McpFace` with `constructor(deps: { sessions: SessionManager; fetchPage: ToolDeclaration; toolDeclarations: ToolDeclaration[]; allowedHosts?: string[] })`, `handle(req, res, body?): Promise<void>`, `closeAll(): Promise<void>`, and (for testing) `makeCallTool(mcpSessionId: string): ToolCaller`.

**Design notes for the implementer (verify against SDK 1.30.0):**

- Stateful session mode: create one `StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized, onsessionclosed, enableDnsRebindingProtection, allowedHosts })` per client. Keep `Map<mcpSessionId, { transport; server; browseSessionId?: string }>`.
- `handle`: read the JSON body for POST. If there's no `Mcp-Session-Id` header and `isInitializeRequest(body)`, create transport+server, `server.connect(transport)`, then `transport.handleRequest(req, res, body)`. If there is a session id, look up the transport and `handleRequest`. Unknown id → respond 404 JSON. On `onsessionclosed(id)` → `sessions.close(browseSessionId)` and delete the map entry.
- Per-client `callTool` (from `makeCallTool(id)`): `fetch_page` → `fetchPage.handler(args, minimalCtx)`. A `browse_*` tool → `callBrowseTool(name, args, (fn) => this.runBrowse(id, fn))`.
- `runBrowse(id, fn)`: lazily `sessions.create()` the first time (store `browseSessionId` on the entry), then `sessions.run(browseSessionId, fn)`. On `SessionNotFound` (idle-evicted), clear the stored id, re-`create()` once, and retry. `SessionCapReached` propagates — `createMcpServer`'s CallTool catch turns it into an `isError` result.

- [ ] **Step 1: Write the failing test** (`src/mcp-http.test.ts`)

Unit-test `makeCallTool` against a stub `SessionManager` (no real browser, no transport):

```ts
import { describe, it, expect, vi } from 'vitest'
import { McpFace } from './mcp-http.js'
import { SessionCapReached, SessionNotFound } from './session-manager.js'
import type { ToolDeclaration } from './core-compat.js'

const fetchPage: ToolDeclaration = {
  name: 'fetch_page',
  description: 'f',
  inputSchema: { type: 'object', properties: {} },
  handler: async (args) => ({ url: (args as { url: string }).url, method: 'stub' }),
}

function mockPage() {
  const loc = {
    first() {
      return this
    },
    click: async () => {},
    ariaSnapshot: async () => '- doc',
  }
  return {
    goto: async () => {},
    url: () => 'https://e/',
    title: async () => 'E',
    locator: () => loc,
    getByRole: () => loc,
  }
}

function stubSessions(overrides: Record<string, unknown> = {}) {
  return {
    createCalls: 0,
    async create() {
      this.createCalls++
      return { id: `bs-${this.createCalls}`, expiresInMs: 1000 }
    },
    async run(_id: string, fn: (p: unknown) => Promise<unknown>) {
      return fn(mockPage())
    },
    async close() {},
    size: 0,
    ...overrides,
  }
}

describe('McpFace.makeCallTool', () => {
  it('runs fetch_page via the tool handler', async () => {
    const face = new McpFace({
      sessions: stubSessions() as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    const call = face.makeCallTool('m1')
    expect(await call('fetch_page', { url: 'u' })).toMatchObject({ url: 'u', method: 'stub' })
  })

  it('lazily creates one browse session and reuses it', async () => {
    const sessions = stubSessions()
    const face = new McpFace({
      sessions: sessions as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    const call = face.makeCallTool('m1')
    await call('browse_navigate', { url: 'https://e' })
    await call('browse_snapshot', {})
    expect(sessions.createCalls).toBe(1)
  })

  it('retries once on SessionNotFound (idle eviction)', async () => {
    let calls = 0
    const sessions = stubSessions({
      async run(_id: string, fn: (p: unknown) => Promise<unknown>) {
        calls++
        if (calls === 1) throw new SessionNotFound('bs-1')
        return fn(mockPage())
      },
    })
    const face = new McpFace({
      sessions: sessions as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    const r = await face.makeCallTool('m1')('browse_snapshot', {})
    expect(r).toMatchObject({ title: 'E' })
    expect(sessions.createCalls).toBe(2)
  })

  it('propagates SessionCapReached', async () => {
    const sessions = stubSessions({
      async create() {
        throw new SessionCapReached(3)
      },
    })
    const face = new McpFace({
      sessions: sessions as never,
      fetchPage,
      toolDeclarations: [fetchPage],
    })
    await expect(face.makeCallTool('m1')('browse_snapshot', {})).rejects.toBeInstanceOf(
      SessionCapReached,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-http.test.ts`
Expected: FAIL — `mcp-http.js` does not exist.

- [ ] **Step 3: Write `src/mcp-http.ts`**

Implement `McpFace` per the design notes. Sketch of the parts the tests pin (transport wiring is exercised by Task 4's handshake test, not here):

```ts
import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer, type ToolCaller } from './mcp-server.js'
import { callBrowseTool, BROWSE_TOOL_OPS } from './browse-tools.js'
import { SessionNotFound, type SessionManager } from './session-manager.js'
import type { ToolDeclaration } from './core-compat.js'
import type { Page } from 'playwright-core'

interface Entry {
  transport: StreamableHTTPServerTransport
  server: ReturnType<typeof createMcpServer>
  browseSessionId?: string
}

export class McpFace {
  private entries = new Map<string, Entry>()
  constructor(
    private deps: {
      sessions: SessionManager
      fetchPage: ToolDeclaration
      toolDeclarations: ToolDeclaration[]
      allowedHosts?: string[]
    },
  ) {}

  makeCallTool(mcpSessionId: string): ToolCaller {
    return async (name, args) => {
      if (name === 'fetch_page') {
        return this.deps.fetchPage.handler(args, {
          credentials: {},
          fetch: globalThis.fetch,
        } as never)
      }
      if (name in BROWSE_TOOL_OPS) {
        return callBrowseTool(name, args, (fn) => this.runBrowse(mcpSessionId, fn))
      }
      throw new Error(`unknown tool: ${name}`)
    }
  }

  private async runBrowse<T>(mcpSessionId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const entry = this.entries.get(mcpSessionId)
    const ensure = async () => {
      if (!entry?.browseSessionId) {
        const { id } = await this.deps.sessions.create()
        if (entry) entry.browseSessionId = id
        return id
      }
      return entry.browseSessionId
    }
    let id = await ensure()
    try {
      return await this.deps.sessions.run(id, fn)
    } catch (err) {
      if (err instanceof SessionNotFound) {
        if (entry) entry.browseSessionId = undefined
        id = await ensure()
        return this.deps.sessions.run(id, fn)
      }
      throw err
    }
  }

  // handle(req, res, body?) — create-or-lookup transport, then transport.handleRequest.
  // onsessionclosed(id): close the browse session + delete the entry. (Task 4 exercises this.)
}
```

The implementer completes `handle` and the transport lifecycle. NOTE: when there is no map entry yet (unit tests call `makeCallTool` without a live transport), `runBrowse` must still work — key the browse session id in a fallback map if `entry` is undefined, OR have the tests register an entry first. Prefer: store `browseSessionId` in a separate `Map<mcpSessionId,string>` owned by `McpFace`, not on the transport entry, so `makeCallTool` works without a transport (this keeps the unit tests honest and decouples browse-session state from transport state).

- [ ] **Step 4: Adjust the implementation so the unit tests pass**

Follow the note above: keep browse-session ids in their own `Map<string,string>` so `makeCallTool` is testable standalone. Run: `npx vitest run src/mcp-http.test.ts && npm run typecheck && npm run lint`
Expected: 4/4 pass; typecheck/lint clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/mcp-http.ts src/mcp-http.test.ts
git add src/mcp-http.ts src/mcp-http.test.ts
git commit -m "$(printf 'feat: McpFace — HTTP MCP with per-client capped browse sessions\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Wire the `/mcp` route + bootstrap + handshake test (`src/routes.ts`, `src/server.ts`)

**Files:**

- Modify: `src/routes.ts` (add `/mcp` route + `RouterDeps.mcp`), `src/server.ts` (construct `McpFace`, close on shutdown)
- Modify: `src/routes.test.ts` (MCP handshake test over the in-process server)

**Interfaces:**

- Consumes: `McpFace` from `./mcp-http.js`.
- Produces: `RouterDeps` gains `mcp: McpFace`; `POST/GET/DELETE /mcp` handled.

- [ ] **Step 1: Write the failing handshake test** (append to `src/routes.test.ts`)

Stand up the real router with a real `McpFace` (backed by a stub `SessionManager` — no browser needed for `initialize`+`listTools`) and drive it with the SDK client over Streamable HTTP.

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpFace } from './mcp-http.js'
import { createTools } from './tools.js'
// Build real tool declarations once (createTools needs a BrowserManager + DomainDb;
// for listTools only the declarations are read, so a minimal/no-op BrowserManager is fine —
// or import the fetch_page declaration set the server uses). The implementer picks the
// lightest real construction that yields the declaration list.

describe('MCP /mcp handshake', () => {
  it('initializes and lists tools including browse_wait', async () => {
    // const mcp = new McpFace({ sessions: <stub>, fetchPage: <decl>, toolDeclarations: <decls> })
    // const base = await start({ fetchPage: ..., sessions: <stub>, mcp })
    // const client = new Client({ name: 't', version: '0' })
    // await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
    // const { tools } = await client.listTools()
    // expect(tools.map(t => t.name)).toContain('browse_wait')
    // expect(tools.map(t => t.name)).toContain('fetch_page')
    // await client.close()
  })
})
```

The implementer fills in the construction (uncomment + wire), choosing the lightest way to get real `toolDeclarations`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes.test.ts -t 'MCP /mcp handshake'`
Expected: FAIL — no `/mcp` route yet (client initialize errors / 404).

- [ ] **Step 3: Add the `/mcp` route in `src/routes.ts`**

Add `mcp: McpFace` to `RouterDeps`. Handle `/mcp` before the final 404. For POST, read the body (reuse `readBody`, parse JSON) and pass to `deps.mcp.handle(req, res, body)`; for GET/DELETE pass through without a body. Example placement (near the other routes):

```ts
if (pathname === '/mcp') {
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : undefined
  await deps.mcp.handle(req, res, body)
  return
}
```

(`McpFace.handle` owns writing the response — the router just delegates. Ensure the outer `try/catch` still guards it.)

- [ ] **Step 4: Wire `src/server.ts`**

Construct the `McpFace` with the real `sessions`, the `fetch_page` declaration, and the full `toolDeclarations` (from `createTools`), plus `allowedHosts`. Pass `mcp` into `createRouter`. Add `mcp.closeAll()` to `shutdown`.

**Host/allowedHosts verification (spec caveat):** determine what `Host` the node server receives behind nginx-proxy-manager. Start with `enableDnsRebindingProtection: true` and `allowedHosts: ['webfetch.home', '127.0.0.1:9000', 'localhost:9000']`, reading an optional `WEBFETCH_MCP_ALLOWED_HOSTS` (comma-separated) override, and a `WEBFETCH_MCP_DNS_REBINDING=false` escape hatch that disables protection. Document the default. If unsure of the forwarded Host at build time, default the escape hatch to protection **on** but make it a one-line env flip — do not hard-break the LAN deploy.

- [ ] **Step 5: Run the handshake test + full gate**

Run: `npx vitest run src/routes.test.ts && npm run typecheck && npm run lint && npm test`
Expected: handshake test passes (initialize + listTools over HTTP); full suite green; integration files still skipped.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/routes.ts src/routes.test.ts src/server.ts
git add src/routes.ts src/routes.test.ts src/server.ts
git commit -m "$(printf 'feat: mount the MCP endpoint at /mcp on the webfetch server\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Docs, OpenAPI note, gated integration test

**Files:**

- Create: `src/mcp.integration.test.ts`
- Modify: `src/openapi.ts`, `README.md`, `package.json`

- [ ] **Step 1: Gated real-browser MCP integration test** (`src/mcp.integration.test.ts`)

Gated by `process.env.MCP_INTEGRATION === '1'` (skipped in `npm test`). Stand up an in-process server with a **real** `BrowserManager` + `SessionManager` + `McpFace`, connect the SDK `Client` over `StreamableHTTPClientTransport`, and:

```ts
// describe.skipIf(process.env.MCP_INTEGRATION !== '1')('MCP over HTTP (live browser)', () => {
//   it('initializes, navigates, and reads a snapshot', async () => {
//     // client.callTool({ name: 'browse_navigate', arguments: { url: 'https://example.com' } })
//     //   → content text JSON has snapshot containing "Example Domain"
//     // then client.callTool({ name: 'fetch_page', arguments: { url: 'https://example.com' } }) succeeds
//   }, 60000)
// })
```

Tear down: close the client, the server, and the `BrowserManager` in `afterAll`.

- [ ] **Step 2: Add the script + verify skip**

`package.json` scripts: `"test:integration:mcp": "MCP_INTEGRATION=1 vitest run src/mcp.integration.test.ts"`.
Run: `npm test` → the file is present but skipped; suite green.

- [ ] **Step 3: Run the live MCP test**

Run: `npm run test:integration:mcp`
Expected: PASS (navigate snapshot contains "Example Domain"; fetch_page returns content). If it cannot launch a browser in the environment, report DONE_WITH_CONCERNS with the skip-verified `npm test` and the exact failure — do not weaken assertions.

- [ ] **Step 4: OpenAPI `/mcp` note** (`src/openapi.ts`)

Add a `/mcp` path documenting it as an MCP Streamable-HTTP endpoint (not a normal REST resource) — e.g. a `post` with a summary "MCP Streamable-HTTP endpoint (JSON-RPC; use an MCP client)" and a free-form description; it need not model the JSON-RPC body. This keeps the served contract honest that the port also speaks MCP.

- [ ] **Step 5: README**

Add an "MCP" section: the endpoint URL (`http://webfetch.home/mcp`), that it's Streamable-HTTP, the tool set (`fetch_page` + `browse_*` incl. `browse_wait`), that each client gets its own capped browser session, and a one-line client example. Note it's the same tools as the stdio `standalone.ts`, now over the network.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/mcp.integration.test.ts src/openapi.ts README.md package.json
git add src/mcp.integration.test.ts src/openapi.ts README.md package.json
git commit -m "$(printf 'test: gated live MCP integration; document the /mcp endpoint\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**

- `/mcp` on existing server via Streamable-HTTP → Tasks 3 (McpFace) + 4 (route/bootstrap).
- Per-client capped browse session (lazy create, retry-on-evict, cap→error) → Task 3.
- Shared `createMcpServer` factory for both faces → Task 2.
- `wait_for`/`browse_wait` in v1, shared `validateWaitFor` → Task 1.
- Identical tool set across stdio + HTTP; uniform envelope → Tasks 1 (dispatch) + 2 (stdio) + 3 (http).
- Security/DNS-rebinding + Host caveat, env escape hatch → Task 4 Step 4.
- Module layout, openapi note, README, gated integration → Tasks 1–5.

**Placeholder scan:** Task 4/5 tests are given as commented skeletons the implementer wires (the exact lightest real-tool-declaration construction and client wiring is left to them, with explicit instructions) — not TODO placeholders. All logic steps carry real code.

**Type consistency:** `callBrowseTool(name, args, run)` / `RunOnPage` / `BrowseArgError` / `BROWSE_TOOL_OPS` (Task 1) are consumed unchanged in Task 3; `createMcpServer`/`ToolCaller` (Task 2) in Tasks 3–4; `McpFace` constructor + `handle`/`closeAll`/`makeCallTool` (Task 3) in Task 4. `validateWaitFor` moves to `browse-tools.ts` in Task 1 and `routes.ts` imports it there (no dangling definition).
