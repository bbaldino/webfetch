import type { PluginDatabase } from './core-compat.js'

export type FetchMethod = 'fetch' | 'browser' | 'auto'

export interface DomainStats {
  domain: string
  method: string
  success: number
  failure: number
  totalBytes: number
  lastUsedAt: string | null
}

export interface DomainConfig {
  domain: string
  method: FetchMethod
  shareCookies: boolean
  createdAt: string
  updatedAt: string
}

export class DomainDb {
  constructor(private db: PluginDatabase) {}

  recordSuccess(domain: string, method: 'fetch' | 'browser', bytes: number): void {
    this.db.raw
      .prepare(
        `INSERT INTO domain_stats (domain, method, success, total_bytes, last_used_at)
         VALUES (?, ?, 1, ?, datetime('now'))
         ON CONFLICT (domain, method) DO UPDATE SET
           success = success + 1,
           total_bytes = total_bytes + ?,
           last_used_at = datetime('now')`,
      )
      .run(domain, method, bytes, bytes)
  }

  recordFailure(domain: string, method: 'fetch' | 'browser'): void {
    this.db.raw
      .prepare(
        `INSERT INTO domain_stats (domain, method, failure, last_used_at)
         VALUES (?, ?, 1, datetime('now'))
         ON CONFLICT (domain, method) DO UPDATE SET
           failure = failure + 1,
           last_used_at = datetime('now')`,
      )
      .run(domain, method)
  }

  getStats(): DomainStats[] {
    return this.db.raw
      .prepare(
        `SELECT domain, method, success, failure, total_bytes as totalBytes, last_used_at as lastUsedAt
           FROM domain_stats
           ORDER BY (success + failure) DESC`,
      )
      .all() as DomainStats[]
  }

  getConfig(domain: string): DomainConfig | null {
    const row = this.db.raw
      .prepare(
        `SELECT domain, method, share_cookies as shareCookies, created_at as createdAt, updated_at as updatedAt
         FROM domain_config WHERE domain = ?`,
      )
      .get(domain) as DomainConfig | undefined
    return row ?? null
  }

  getAllConfigs(): DomainConfig[] {
    return this.db.raw
      .prepare(
        `SELECT domain, method, share_cookies as shareCookies, created_at as createdAt, updated_at as updatedAt
         FROM domain_config ORDER BY domain`,
      )
      .all() as DomainConfig[]
  }

  setConfig(domain: string, method: FetchMethod, shareCookies: boolean): void {
    this.db.raw
      .prepare(
        `INSERT INTO domain_config (domain, method, share_cookies)
         VALUES (?, ?, ?)
         ON CONFLICT (domain) DO UPDATE SET
           method = ?,
           share_cookies = ?,
           updated_at = datetime('now')`,
      )
      .run(domain, method, shareCookies ? 1 : 0, method, shareCookies ? 1 : 0)
  }

  deleteConfig(domain: string): void {
    this.db.raw.prepare('DELETE FROM domain_config WHERE domain = ?').run(domain)
  }

  /**
   * Determine the best method for a domain based on config and stats.
   * Returns 'fetch', 'browser', or 'auto' (caller decides).
   */
  getPreferredMethod(domain: string): FetchMethod {
    // Check explicit config first
    const config = this.getConfig(domain)
    if (config && config.method !== 'auto') {
      return config.method
    }

    // Check stats — if fetch has a high failure rate, prefer browser
    const stats = this.db.raw
      .prepare('SELECT method, success, failure FROM domain_stats WHERE domain = ?')
      .all(domain) as Array<{ method: string; success: number; failure: number }>

    const fetchStats = stats.find((s) => s.method === 'fetch')
    if (fetchStats) {
      const total = fetchStats.success + fetchStats.failure
      if (total >= 3 && fetchStats.failure / total > 0.5) {
        // More than 50% failure rate with 3+ attempts — prefer browser
        return 'browser'
      }
    }

    return 'auto'
  }
}
