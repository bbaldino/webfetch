import { describe, it, expect, afterEach } from 'vitest'
import { detectBlock, blockNotice, setJarCoverage } from './detect-block.js'

afterEach(() => setJarCoverage(() => false))

describe('detectBlock', () => {
  it('flags a DataDome challenge by its captcha iframe', () => {
    expect(
      detectBlock({
        title: 'yelp.com',
        text: '',
        frameUrls: [
          'https://www.yelp.com/biz/x',
          'https://geo.captcha-delivery.com/captcha/?initialCid=abc',
        ],
      }),
    ).toBe('datadome')
  })

  it('flags a DataDome block page by its html', () => {
    expect(
      detectBlock({
        html: '<html><head><title>yelp.com</title></head><body><iframe src="https://geo.captcha-delivery.com/captcha/?x=1"></iframe></body></html>',
        text: '',
      }),
    ).toBe('datadome')
  })

  it('flags a Cloudflare interstitial by title with little text', () => {
    expect(detectBlock({ title: 'Just a moment...', text: 'Checking your browser' })).toBe(
      'cloudflare',
    )
  })

  it('flags an Akamai access-denied page', () => {
    expect(
      detectBlock({
        title: 'Access Denied',
        text: "You don't have permission to access this resource. Reference #18.abc",
      }),
    ).toBe('akamai')
  })

  it('flags a PerimeterX press-and-hold page', () => {
    expect(
      detectBlock({
        html: '<div id="px-captcha"></div>',
        text: 'Press & Hold to confirm you are a human',
      }),
    ).toBe('perimeterx')
  })

  it('flags a 403/429 with an almost-empty body', () => {
    expect(detectBlock({ status: 403, text: '' })).toBe('http-403')
    expect(detectBlock({ status: 429, text: 'slow down' })).toBe('http-429')
  })

  it('flags DataDome challenge even with substantial page text when captcha iframe is present', () => {
    const text = 'x'.repeat(5000) + ' some real content here'
    expect(
      detectBlock({
        text,
        frameUrls: ['https://geo.captcha-delivery.com/captcha/?x=1'],
      }),
    ).toBe('datadome')
  })

  it('does not flag real pages that merely mention captcha or load bot scripts', () => {
    const text = 'x'.repeat(5000) + ' we use a captcha on our signup form'
    expect(
      detectBlock({
        status: 200,
        title: 'Gary Danko - Yelp',
        text,
        html: '<script src="https://js.datadome.co/tags.js"></script>',
      }),
    ).toBeNull()
    expect(detectBlock({ status: 403, text: 'x'.repeat(2000) })).toBeNull()
  })
})

describe('blockNotice', () => {
  it('says the jar looks stale when the host is covered by the jar', () => {
    setJarCoverage((h) => h.endsWith('yelp.com'))
    const n = blockNotice('https://www.yelp.com/biz/x', 'datadome')
    expect(n.reason).toBe('datadome')
    expect(n.hint).toContain("yelp.com's bot protection")
    expect(n.hint).toContain('look stale')
  })

  it('suggests exporting cookies when the host is not covered', () => {
    const n = blockNotice('https://www.wayfair.com/', 'perimeterx')
    expect(n.hint).toContain("wayfair.com's bot protection")
    expect(n.hint).toContain('export')
    expect(n.hint).not.toContain('look stale')
  })

  it('handles invalid URLs gracefully without throwing', () => {
    const n = blockNotice('not a url', 'http-403')
    expect(n.reason).toBe('http-403')
    expect(n.hint).toContain('bot protection')
  })
})
