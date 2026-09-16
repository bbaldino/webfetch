// Live-network integration checks for the Reddit fetch chain. These hit
// reddit.com directly and are inherently flaky (rate limits), so they are NOT
// part of `npm test` — they only run when REDDIT_INTEGRATION=1 (see the
// `test:integration` script). The corpus in test/reddit-corpus.json holds real
// URLs that have misbehaved in the wild; add to it when a link regresses.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fetchReddit } from './reddit.js'

interface CorpusEntry {
  url: string
  note?: string
  expectTitleContains?: string
}

const corpus: CorpusEntry[] = JSON.parse(
  readFileSync(new URL('../test/reddit-corpus.json', import.meta.url), 'utf8'),
)

describe.skipIf(process.env.REDDIT_INTEGRATION !== '1')('reddit corpus (live network)', () => {
  for (const entry of corpus) {
    it(`fetches ${entry.url} as real content`, async () => {
      const r = await fetchReddit(entry.url)
      expect(r.ok).toBe(true)
      // The 404 "page not found" feed must never be surfaced as success.
      expect(r.content.toLowerCase()).not.toContain('page not found')
      // Nor may the site header/footer chrome leak in when we fall to a scrape.
      expect(r.content).not.toContain('Skip to main content')
      expect(r.content).not.toContain('RESOURCES About Reddit')
      if (entry.expectTitleContains) {
        expect(r.title ?? '').toContain(entry.expectTitleContains)
      }
    }, 60000)
  }
})
