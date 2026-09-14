import type { Page } from 'playwright-core'

/**
 * Take an accessibility snapshot of the page using Playwright's built-in ariaSnapshot.
 * Returns a YAML-like text representation of the accessibility tree.
 *
 * Interactive elements are identified by role + name, which maps directly
 * to Playwright's getByRole() API for subsequent interactions.
 */
export async function takeSnapshot(page: Page): Promise<string> {
  try {
    return await page.locator(':root').ariaSnapshot()
  } catch {
    return '[Unable to take accessibility snapshot]'
  }
}
