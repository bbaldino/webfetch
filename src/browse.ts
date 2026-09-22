import type { Page } from 'playwright-core'
import { takeSnapshot } from './snapshot.js'
import { rewriteUrl } from './url-rewrite.js'
import { detectBlock, blockNotice, type BlockNotice } from './detect-block.js'

export interface BrowseResult {
  url: string
  title: string
  snapshot: string
  blocked?: BlockNotice
}

export type WaitFor = { role: string; name: string } | { text: string }

export class InvalidRoleError extends Error {
  constructor(role: string) {
    super(`Invalid role "${role}". Use a role from the accessibility snapshot.`)
    this.name = 'InvalidRoleError'
  }
}

// Moved verbatim from tools.ts — the ARIA roles Playwright's getByRole accepts.
const VALID_ROLES = [
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
] as const
type AriaRole = (typeof VALID_ROLES)[number]

function assertRole(role: string): asserts role is AriaRole {
  if (!VALID_ROLES.includes(role as AriaRole)) throw new InvalidRoleError(role)
}

const DEFAULT_NAV_TIMEOUT = 30000
const DEFAULT_WAIT_TIMEOUT = 15000

async function envelope(page: Page): Promise<BrowseResult> {
  const [title, snapshot] = await Promise.all([page.title().catch(() => ''), takeSnapshot(page)])
  const url = page.url()
  let frameUrls: string[] = []
  try {
    frameUrls = page.frames().map((f) => f.url())
  } catch {
    /* page closing */
  }
  const reason = detectBlock({ title, text: snapshot, frameUrls })
  return reason
    ? { url, title, snapshot, blocked: blockNotice(url, reason) }
    : { url, title, snapshot }
}

async function applyWait(
  page: Page,
  wait: WaitFor,
  timeoutMs = DEFAULT_WAIT_TIMEOUT,
): Promise<void> {
  if ('text' in wait) {
    await page.getByText(wait.text).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return
  }
  assertRole(wait.role)
  await page.getByRole(wait.role, { name: wait.name }).first().waitFor({
    state: 'visible',
    timeout: timeoutMs,
  })
}

export async function navigate(
  page: Page,
  url: string,
  opts: { waitFor?: WaitFor; timeoutMs?: number } = {},
): Promise<BrowseResult> {
  await page.goto(rewriteUrl(url), {
    waitUntil: 'domcontentloaded',
    timeout: opts.timeoutMs ?? DEFAULT_NAV_TIMEOUT,
  })
  if (opts.waitFor) await applyWait(page, opts.waitFor, opts.timeoutMs)
  return envelope(page)
}

export async function snapshot(page: Page): Promise<BrowseResult> {
  return envelope(page)
}

export async function click(page: Page, role: string, name: string): Promise<BrowseResult> {
  assertRole(role)
  await page.getByRole(role, { name }).first().click({ timeout: 5000 })
  return envelope(page)
}

export async function type(
  page: Page,
  role: string,
  name: string,
  text: string,
  submit = false,
): Promise<BrowseResult> {
  assertRole(role)
  const el = page.getByRole(role, { name }).first()
  await el.click({ timeout: 5000 })
  await el.fill(text)
  if (submit) await page.keyboard.press('Enter')
  return envelope(page)
}

export async function scroll(
  page: Page,
  direction: 'up' | 'down',
  amount = 500,
): Promise<BrowseResult> {
  await page.mouse.wheel(0, direction === 'down' ? amount : -amount)
  return envelope(page)
}

export async function goBack(page: Page): Promise<BrowseResult> {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
  return envelope(page)
}

export async function selectOption(
  page: Page,
  role: string,
  name: string,
  values: string[],
): Promise<BrowseResult> {
  assertRole(role)
  await page.getByRole(role, { name }).first().selectOption(values)
  return envelope(page)
}

export async function pressKey(page: Page, key: string): Promise<BrowseResult> {
  await page.keyboard.press(key)
  return envelope(page)
}

export async function waitFor(
  page: Page,
  wait: WaitFor,
  timeoutMs?: number,
): Promise<BrowseResult> {
  await applyWait(page, wait, timeoutMs)
  return envelope(page)
}
