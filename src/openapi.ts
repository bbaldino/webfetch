// OpenAPI 3.1 description of webfetch's REST surface, served verbatim at
// GET /openapi.json so the running service is self-describing.
//
// SESSION_OPS is the single source of truth for the interactive op names: the
// per-op `/sessions/{id}/{op}` paths below are generated from it, and
// routes.test.ts asserts the router dispatches every op in this list — so the
// spec and the router cannot silently drift apart.

export const SESSION_OPS = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'scroll',
  'back',
  'select',
  'press',
  'wait',
] as const

export type SessionOp = (typeof SESSION_OPS)[number]

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    hint: { type: 'string' },
  },
}

const browseResultSchema = {
  type: 'object',
  required: ['url', 'title', 'snapshot'],
  properties: {
    url: { type: 'string', description: 'The page URL after the operation.' },
    title: { type: 'string' },
    snapshot: {
      type: 'string',
      description:
        'Playwright ariaSnapshot — a YAML-like accessibility tree; interactive nodes carry the role+name used by click/type/select.',
    },
  },
}

const waitForSchema = {
  description: 'Wait until an element with the given role+name, or the given text, is visible.',
  oneOf: [
    {
      type: 'object',
      required: ['role', 'name'],
      properties: { role: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
  ],
}

const timeoutMs = { type: 'integer', minimum: 0, maximum: 60000 }

// Per-op request body schema. `null` means the op takes no body.
const opBodies: Record<SessionOp, Record<string, unknown> | null> = {
  navigate: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string' }, wait_for: waitForSchema, timeout_ms: timeoutMs },
  },
  snapshot: null,
  click: {
    type: 'object',
    required: ['role', 'name'],
    properties: { role: { type: 'string' }, name: { type: 'string' } },
  },
  type: {
    type: 'object',
    required: ['role', 'name', 'text'],
    properties: {
      role: { type: 'string' },
      name: { type: 'string' },
      text: { type: 'string' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
    },
  },
  scroll: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down'], default: 'down' },
      amount: { type: 'number', description: 'Pixels (default 500).' },
    },
  },
  back: null,
  select: {
    type: 'object',
    required: ['role', 'name', 'values'],
    properties: {
      role: { type: 'string' },
      name: { type: 'string' },
      values: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
  },
  press: {
    type: 'object',
    required: ['key'],
    properties: { key: { type: 'string', description: 'e.g. "Enter", "Escape", "ArrowDown".' } },
  },
  wait: {
    type: 'object',
    required: ['wait_for'],
    properties: { wait_for: waitForSchema, timeout_ms: timeoutMs },
  },
}

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Session id returned by POST /sessions.',
}

const jsonBody = (schema: unknown) => ({ content: { 'application/json': { schema } } })

// The shared response set for every page-touching session op.
const opResponses = {
  '200': {
    description: 'Page state after the operation.',
    ...jsonBody({ $ref: '#/components/schemas/BrowseResult' }),
  },
  '400': {
    description: 'Invalid body or role.',
    ...jsonBody({ $ref: '#/components/schemas/Error' }),
  },
  '404': {
    description: 'Unknown or expired session.',
    ...jsonBody({ $ref: '#/components/schemas/Error' }),
  },
  '429': {
    description: 'Session cap reached.',
    ...jsonBody({ $ref: '#/components/schemas/Error' }),
  },
  '502': {
    description: 'Browser/navigation error or element not found.',
    ...jsonBody({ $ref: '#/components/schemas/Error' }),
  },
}

const sessionOpPaths: Record<string, unknown> = {}
for (const op of SESSION_OPS) {
  const body = opBodies[op]
  sessionOpPaths[`/sessions/{id}/${op}`] = {
    post: {
      operationId: `session_${op}`,
      summary: `${op} within a browsing session`,
      tags: ['sessions'],
      parameters: [idParam],
      ...(body ? { requestBody: { required: true, ...jsonBody(body) } } : {}),
      responses: opResponses,
    },
  }
}

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'webfetch',
    // API contract version — deliberately decoupled from the package/release version.
    version: '1.0.0',
    description:
      'Self-hosted web-fetch service. One-shot POST /fetch, plus a /sessions API for multi-step interactive browsing (navigate, click, type, snapshot) over one real browser page. LAN-only, no auth.',
  },
  tags: [{ name: 'sessions', description: 'Stateful, multi-step interactive browsing.' }],
  paths: {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness check',
        responses: {
          '200': {
            description: 'Service is up.',
            ...jsonBody({
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', enum: ['ok'] } },
            }),
          },
        },
      },
    },
    '/fetch': {
      post: {
        operationId: 'fetch',
        summary: 'One-shot fetch of a URL to readable text',
        requestBody: {
          required: true,
          ...jsonBody({
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string' } },
          }),
        },
        responses: {
          '200': {
            description: 'Extracted page.',
            ...jsonBody({
              type: 'object',
              required: ['title', 'text', 'final_url', 'method'],
              properties: {
                title: { type: 'string' },
                text: { type: 'string' },
                final_url: { type: 'string' },
                method: {
                  type: 'string',
                  description: 'Which strategy succeeded (fetch/browser/reddit-*).',
                },
              },
            }),
          },
          '400': {
            description: 'Missing/invalid url.',
            ...jsonBody({ $ref: '#/components/schemas/Error' }),
          },
          '502': {
            description: 'Fetch failed.',
            ...jsonBody({
              type: 'object',
              required: ['error'],
              properties: { error: { type: 'string' }, final_url: { type: 'string' } },
            }),
          },
        },
      },
    },
    '/sessions': {
      post: {
        operationId: 'createSession',
        summary: 'Open a browsing session',
        tags: ['sessions'],
        responses: {
          '201': {
            description: 'Session created.',
            ...jsonBody({
              type: 'object',
              required: ['session_id', 'expires_in_ms'],
              properties: {
                session_id: { type: 'string' },
                expires_in_ms: { type: 'integer', description: 'Idle TTL; each op resets it.' },
              },
            }),
          },
          '429': {
            description: 'Session cap reached.',
            ...jsonBody({ $ref: '#/components/schemas/Error' }),
          },
        },
      },
    },
    '/sessions/{id}': {
      delete: {
        operationId: 'closeSession',
        summary: 'Close a session',
        tags: ['sessions'],
        parameters: [idParam],
        responses: { '204': { description: 'Closed (idempotent).' } },
      },
    },
    ...sessionOpPaths,
  },
  components: {
    schemas: {
      Error: errorSchema,
      BrowseResult: browseResultSchema,
      WaitFor: waitForSchema,
    },
  },
}
