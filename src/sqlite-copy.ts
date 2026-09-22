// Browsers hold their cookie DBs locked while running, so read a throwaway copy.
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export function withSqliteCopy<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'webfetch-cookies-'))
  try {
    const copy = join(dir, basename(dbPath))
    copyFileSync(dbPath, copy)
    // In WAL mode, recent writes (e.g. a freshly rotated datadome cookie) live only in
    // -wal until the browser checkpoints it into the main file — copy the sidecars too, or
    // a main-file-only copy silently reads stale data.
    for (const ext of ['-journal', '-wal', '-shm']) {
      if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext)
    }
    const db = new Database(copy, { readonly: true })
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
