import { describe, it, expect, afterEach } from 'vitest'
import { browserOutcome } from './tools.js'
import { setJarCoverage } from './detect-block.js'

afterEach(() => setJarCoverage(() => false))
const base = { finalUrl: 'https://www.yelp.com/biz/x', title: 'yelp.com' }

describe('browserOutcome', () => {
  it('reports a DataDome wall as a failure with a stale-jar hint when the jar covers the site', () => {
    setJarCoverage((h) => h.endsWith('yelp.com'))
    const o = browserOutcome('https://www.yelp.com/biz/x', {
      ...base,
      status: 403,
      text: '',
      frameUrls: ['https://geo.captcha-delivery.com/captcha/?a=1'],
    })
    expect(o.ok).toBe(false)
    expect(o.content).toContain('look stale')
  })
  it('never reports empty content as success', () => {
    const o = browserOutcome('https://example.org/', {
      ...base,
      finalUrl: 'https://example.org/',
      status: 200,
      text: '',
    })
    expect(o.ok).toBe(false)
    expect(o.content).toBe('no content extracted from example.org')
  })
  it('passes real content through', () => {
    const o = browserOutcome('https://example.org/', { ...base, status: 200, text: 'hello world' })
    expect(o).toMatchObject({ ok: true, content: 'hello world', bytes: 11 })
  })
})
