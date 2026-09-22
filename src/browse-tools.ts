import type { Page } from 'playwright-core'
import * as browse from './browse.js'

export class BrowseArgError extends Error {}

const MAX_TIMEOUT_MS = 60000

function needStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0)
    throw new BrowseArgError(`"${key}" string is required`)
  return v
}

// Shared shape validation for `wait_for`, used both where it's required (the
// `wait` op) and where it's optional (the `navigate` op's inline wait). If a
// `text` key is present it must be a non-empty string — this matches
// browse.applyWait's `'text' in wait` check, which would otherwise take the
// (broken) empty-text branch instead of falling through to role/name.
export function validateWaitFor(wf: unknown): browse.WaitFor {
  if (!wf || typeof wf !== 'object')
    throw new BrowseArgError('"wait_for" must be {text} or {role,name}')
  const w = wf as { text?: unknown; role?: unknown; name?: unknown }
  if ('text' in w) {
    if (typeof w.text !== 'string' || w.text.length === 0)
      throw new BrowseArgError('"wait_for.text" must be a non-empty string')
    return { text: w.text }
  }
  if (typeof w.role !== 'string' || w.role.length === 0 || typeof w.name !== 'string')
    throw new BrowseArgError('"wait_for" must be {text} or {role,name}')
  return { role: w.role, name: w.name }
}

function optWaitFor(args: Record<string, unknown>): browse.WaitFor | undefined {
  return args.wait_for === undefined ? undefined : validateWaitFor(args.wait_for)
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new BrowseArgError(`"${key}" must be a number`)
  return v
}

function optTimeout(args: Record<string, unknown>): number | undefined {
  const v = optNum(args, 'timeout_ms')
  return v === undefined ? undefined : Math.min(v, MAX_TIMEOUT_MS)
}

export const BROWSE_TOOL_OPS: Record<string, string> = {
  browse_navigate: 'navigate',
  browse_snapshot: 'snapshot',
  browse_click: 'click',
  browse_type: 'type',
  browse_scroll: 'scroll',
  browse_go_back: 'back',
  browse_select_option: 'select',
  browse_press_key: 'press',
  browse_wait: 'wait',
}

export type RunOnPage = <T>(fn: (page: Page) => Promise<T>) => Promise<T>

export async function callBrowseTool(
  toolName: string,
  args: Record<string, unknown>,
  run: RunOnPage,
): Promise<browse.BrowseResult> {
  const op = BROWSE_TOOL_OPS[toolName]
  switch (op) {
    case 'navigate':
      return run((p) =>
        browse.navigate(p, needStr(args, 'url'), {
          waitFor: optWaitFor(args),
          timeoutMs: optTimeout(args),
        }),
      )
    case 'snapshot':
      return run((p) => browse.snapshot(p))
    case 'click':
      return run((p) => browse.click(p, needStr(args, 'role'), needStr(args, 'name')))
    case 'type':
      return run((p) =>
        browse.type(
          p,
          needStr(args, 'role'),
          needStr(args, 'name'),
          needStr(args, 'text'),
          args.submit === true,
        ),
      )
    case 'scroll':
      return run((p) =>
        browse.scroll(p, args.direction === 'up' ? 'up' : 'down', optNum(args, 'amount')),
      )
    case 'back':
      return run((p) => browse.goBack(p))
    case 'select': {
      const values = args.values
      if (!Array.isArray(values) || values.length === 0)
        throw new BrowseArgError('"values" array is required')
      return run((p) =>
        browse.selectOption(p, needStr(args, 'role'), needStr(args, 'name'), values as string[]),
      )
    }
    case 'press':
      return run((p) => browse.pressKey(p, needStr(args, 'key')))
    case 'wait':
      return run((p) => browse.waitFor(p, validateWaitFor(args.wait_for), optTimeout(args)))
    default:
      throw new BrowseArgError(`unknown browse tool "${toolName}"`)
  }
}
