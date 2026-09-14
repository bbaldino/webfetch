// Vendored compatibility layer.
//
// webfetch started life as raven's `web-access` plugin, a package inside the raven
// monorepo that leaned on `@raven-ai/core` for three small things: the `defineTool`
// helper + its tool types, a `PluginDatabase` shape, and a SQL-migration runner.
// Extracting web-fetch into its own project, those three bits are reproduced here so
// this project has ZERO dependency on the raven monorepo. They are intentionally
// verbatim in behavior — if the upstream versions change, this file is the seam to
// reconcile.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { toJSONSchema, type ZodType } from 'zod'

// ── Tool types ────────────────────────────────────────────────────────────────

export interface ToolInputSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
}

export interface ToolContext {
  credentials: Record<string, string>
  fetch: typeof globalThis.fetch
  /** The channelId the calling agent is currently servicing, if any. */
  channelId?: string
  /** Name of the calling agent, if any. */
  agentName?: string
}

export interface ToolDeclaration {
  name: string
  description: string
  inputSchema?: ToolInputSchema
  credentials?: string[]
  handler: (params: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown
}

// ── Plugin database shape ───────────────────────────────────────────────────────

/** A thin wrapper over a better-sqlite3 handle. `DomainDb` reads/writes through `.raw`. */
export interface PluginDatabase {
  readonly raw: Database
}

// ── defineTool ──────────────────────────────────────────────────────────────────

/**
 * Define a tool with a zod schema for type-safe params. The schema generates the
 * MCP `inputSchema`, parses/validates incoming params at runtime, and types the
 * handler's `params`.
 */
export function defineTool<T>(def: {
  name: string
  description: string
  params: ZodType<T>
  credentials?: string[]
  handler: (params: T, ctx: ToolContext) => Promise<unknown> | unknown
}): ToolDeclaration {
  const jsonSchema = toJSONSchema(def.params) as Record<string, unknown>

  const inputSchema: ToolInputSchema = {
    type: 'object',
    properties: (jsonSchema.properties as Record<string, unknown>) ?? {},
    required: jsonSchema.required as string[] | undefined,
  }

  return {
    name: def.name,
    description: def.description,
    inputSchema,
    credentials: def.credentials,
    handler: (raw, ctx) => {
      const parsed = def.params.parse(raw)
      return def.handler(parsed, ctx)
    },
  }
}

// ── SQL migrations ──────────────────────────────────────────────────────────────

export interface MigrationDb {
  exec(sql: string): void
}

export interface Migration {
  id: string
  up: (db: MigrationDb) => void
}

/**
 * Create or update the SQLite tables from a `migrations/` directory beside the
 * project's `package.json`. Files are named `NNN-description.sql`, applied in
 * filename order, each exactly once per database (the id is recorded in a
 * `migrations` table). Pass `import.meta.url`; the package root is located by
 * walking up to the nearest package.json, so this works from source (`tsx`) or
 * from the compiled `dist/`.
 */
export function runMigrations(db: Database, moduleUrl: string): void {
  runMigrationsInternal(db, loadSqlMigrations(migrationsDirFor(moduleUrl)))
}

function loadSqlMigrations(dir: string): Migration[] {
  let files: string[]
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
  } catch {
    return []
  }

  return files.map((file) => ({
    id: file.replace(/\.sql$/, ''),
    up: (db) => {
      const sql = readFileSync(resolve(dir, file), 'utf-8')
      db.exec(sql)
    },
  }))
}

function migrationsDirFor(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return resolve(dir, 'migrations')
    const parent = dirname(dir)
    if (parent === dir) {
      return resolve(dirname(fileURLToPath(moduleUrl)), '..', 'migrations')
    }
    dir = parent
  }
}

export function runMigrationsInternal(db: Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)

  const checkMigration = db.prepare('SELECT id FROM migrations WHERE id = ?')
  const insertMigration = db.prepare('INSERT INTO migrations (id) VALUES (?)')

  for (const migration of migrations) {
    const existing = checkMigration.get(migration.id)
    if (!existing) {
      db.transaction(() => {
        migration.up(db)
        insertMigration.run(migration.id)
      })()
    }
  }
}
