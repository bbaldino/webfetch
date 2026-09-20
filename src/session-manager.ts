import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import type { BrowserManager } from './browser-manager.js'

export class SessionCapReached extends Error {
  constructor(max: number) {
    super(`session cap reached (${max})`)
    this.name = 'SessionCapReached'
  }
}

export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`unknown or expired session: ${id}`)
    this.name = 'SessionNotFound'
  }
}

interface Entry {
  timer: ReturnType<typeof setTimeout>
  queue: Promise<unknown>
}

export class SessionManager {
  private entries = new Map<string, Entry>()

  constructor(
    private bm: BrowserManager,
    private opts: { max: number; ttlMs: number },
  ) {}

  get size(): number {
    return this.entries.size
  }

  async create(): Promise<{ id: string; expiresInMs: number }> {
    if (this.entries.size >= this.opts.max) throw new SessionCapReached(this.opts.max)
    const id = randomUUID()
    await this.bm.getSession(id) // eagerly open the context/page
    this.entries.set(id, { timer: this.arm(id), queue: Promise.resolve() })
    return { id, expiresInMs: this.opts.ttlMs }
  }

  async run<T>(id: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const entry = this.entries.get(id)
    if (!entry) throw new SessionNotFound(id)
    const task = entry.queue.then(async () => {
      if (!this.entries.has(id)) throw new SessionNotFound(id) // evicted while queued
      const session = await this.bm.getSession(id)
      try {
        return await fn(session.page)
      } finally {
        this.touch(id)
      }
    })
    entry.queue = task.then(
      () => {},
      () => {},
    )
    return task
  }

  async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.entries.delete(id)
    await this.bm.closeSession(id)
  }

  private touch(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.timer = this.arm(id)
  }

  private arm(id: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      void this.close(id)
    }, this.opts.ttlMs)
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      ;(t as { unref: () => void }).unref()
    }
    return t
  }
}
