import { describe, it, expect, vi } from 'vitest'
import * as browse from './browse.js'
import { InvalidRoleError } from './browse.js'

function mockPage(overrides: Record<string, unknown> = {}) {
  const locator = {
    first() {
      return this
    },
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    ariaSnapshot: vi.fn(async () => '- document:\n  - heading "Hi"'),
  }
  const page = {
    goto: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    url: () => 'https://example.com/',
    title: async () => 'Example',
    locator: () => locator,
    getByRole: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    mouse: { wheel: vi.fn(async () => {}) },
    keyboard: { press: vi.fn(async () => {}) },
    ...overrides,
  }
  return { page, locator }
}

describe('BrowseController', () => {
  it('navigate rewrites the url, uses domcontentloaded, returns the envelope', async () => {
    const { page } = mockPage()
    const r = await browse.navigate(page as never, 'https://example.com')
    expect(page.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
    expect(r).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      snapshot: '- document:\n  - heading "Hi"',
    })
  })

  it('navigate applies a wait_for condition when given', async () => {
    const { page, locator } = mockPage()
    await browse.navigate(page as never, 'https://example.com', { waitFor: { text: 'Loaded' } })
    expect(page.getByText).toHaveBeenCalledWith('Loaded')
    expect(locator.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'visible' }))
  })

  it('click validates the role and clicks by role+name', async () => {
    const { page, locator } = mockPage()
    await browse.click(page as never, 'button', 'Sign in')
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Sign in' })
    expect(locator.click).toHaveBeenCalled()
  })

  it('click rejects an invalid role', async () => {
    const { page } = mockPage()
    await expect(browse.click(page as never, 'notarole', 'x')).rejects.toBeInstanceOf(
      InvalidRoleError,
    )
  })

  it('type fills and optionally submits', async () => {
    const { page, locator } = mockPage()
    await browse.type(page as never, 'textbox', 'Search', 'hello', true)
    expect(locator.fill).toHaveBeenCalledWith('hello')
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter')
  })

  it('waitFor waits on a role+name locator', async () => {
    const { page, locator } = mockPage()
    await browse.waitFor(page as never, { role: 'button', name: 'Go' }, 1234)
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Go' })
    expect(locator.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 1234 })
  })
})
