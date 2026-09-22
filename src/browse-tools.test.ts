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
