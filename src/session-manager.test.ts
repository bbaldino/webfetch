import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager, SessionCapReached, SessionNotFound } from './session-manager.js'

function stubBm() {
  return {
    getSession: vi.fn(async (id: string) => ({
      page: { url: () => `about:blank#${id}` },
      context: {},
      domain: undefined,
    })),
    closeSession: vi.fn(async () => {}),
  }
}

describe('SessionManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('creates sessions up to the cap, then throws SessionCapReached', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 2, ttlMs: 1000 })
    await sm.create()
    await sm.create()
    expect(sm.size).toBe(2)
    await expect(sm.create()).rejects.toBeInstanceOf(SessionCapReached)
  })

  it('run throws SessionNotFound for an unknown id', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 2, ttlMs: 1000 })
    await expect(sm.run('nope', async () => 1)).rejects.toBeInstanceOf(SessionNotFound)
  })

  it('evicts a session after the idle TTL and frees a cap slot', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 1, ttlMs: 1000 })
    const { id } = await sm.create()
    await vi.advanceTimersByTimeAsync(1001)
    expect(sm.size).toBe(0)
    expect(bm.closeSession).toHaveBeenCalledWith(id)
    await expect(sm.create()).resolves.toBeTruthy() // slot freed
  })

  it('serializes operations on one session', async () => {
    const bm = stubBm()
    const sm = new SessionManager(bm as never, { max: 1, ttlMs: 10000 })
    const { id } = await sm.create()
    const order: string[] = []
    const slow = sm.run(id, async () => {
      order.push('start-a')
      await new Promise((r) => setTimeout(r, 50))
      order.push('end-a')
    })
    const fast = sm.run(id, async () => {
      order.push('b')
    })
    await vi.advanceTimersByTimeAsync(60)
    await Promise.all([slow, fast])
    expect(order).toEqual(['start-a', 'end-a', 'b'])
  })
})
