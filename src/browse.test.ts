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
  it('navigate uses domcontentloaded and returns the envelope', async () => {
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

  it('navigate rewrites reddit.com urls to old.reddit.com', async () => {
    const { page } = mockPage()
    await browse.navigate(page as never, 'https://www.reddit.com/r/test')
    expect(page.goto).toHaveBeenCalledWith(
      'https://old.reddit.com/r/test',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
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

  it('scroll sends positive delta for down', async () => {
    const { page } = mockPage()
    await browse.scroll(page as never, 'down', 500)
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 500)
  })

  it('scroll sends negative delta for up', async () => {
    const { page } = mockPage()
    await browse.scroll(page as never, 'up', 500)
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, -500)
  })

  it('goBack navigates back and returns the envelope', async () => {
    const { page } = mockPage()
    const r = await browse.goBack(page as never)
    expect(page.goBack).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
    expect(r).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      snapshot: '- document:\n  - heading "Hi"',
    })
  })

  it('selectOption passes values array to locator', async () => {
    const { page, locator } = mockPage()
    await browse.selectOption(page as never, 'combobox', 'Choose', ['a', 'b'])
    expect(locator.selectOption).toHaveBeenCalledWith(['a', 'b'])
  })

  it('pressKey presses the given key', async () => {
    const { page } = mockPage()
    await browse.pressKey(page as never, 'Escape')
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape')
  })

  it('waitFor waits on a role+name locator', async () => {
    const { page, locator } = mockPage()
    await browse.waitFor(page as never, { role: 'button', name: 'Go' }, 1234)
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Go' })
    expect(locator.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 1234 })
  })

  it('adds a blocked notice to the envelope when the page is a bot wall', async () => {
    const { page } = mockPage({
      frames: () => [{ url: () => 'https://geo.captcha-delivery.com/captcha/?x' }],
    })
    const r = await browse.snapshot(page as never)
    expect(r.blocked?.reason).toBe('datadome')
  })

  it('omits blocked for normal pages', async () => {
    const { page } = mockPage()
    expect((await browse.snapshot(page as never)).blocked).toBeUndefined()
  })

  it('omits blocked for a normal page whose frames are not captchas', async () => {
    const { page } = mockPage({
      frames: () => [
        { url: () => 'https://example.com/' },
        { url: () => 'https://www.youtube.com/embed/abc' },
      ],
    })
    expect((await browse.snapshot(page as never)).blocked).toBeUndefined()
  })
})
