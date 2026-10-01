# Redlib as the first Reddit tier — design

**Status:** draft for review
**Date:** 2026-10-01

## Goal

Reddit is reportedly shutting off RSS access, which is webfetch's working route for
Reddit posts today. Add a self-hosted [Redlib](https://github.com/redlib-org/redlib)
instance as the first Reddit tier: faster, full comment threads (nested, with scores),
and subreddit listings — with the existing chain (RSS → JSON → old.reddit →
FeedFetcher → browser) kept behind it as the fallback.

## Background

A spike on 2026-10-01 (Redlib built from `main` @ `a4d36e9`, on hardac, our public IP):

| Same posts              | Redlib                   | RSS (today)                |
| ----------------------- | ------------------------ | -------------------------- |
| Latency                 | 0.6–1.3 s                | 0.9–2.7 s                  |
| Comments (Qwen post)    | 195, nested, with scores | ~20, flat, no scores       |
| Subreddit listings      | yes                      | no (posts only)            |
| Share links (`/s/<id>`) | resolved                 | resolved by webfetch first |

Redlib needs no account: it gets an anonymous logged-out app token. The official
quay.io image is stale and fails OAuth (upstream #485, #551), so it's built from a
pinned commit. Reddit periodically blocks Redlib by IP; that's why it's a tier, not a
replacement.

## Non-goals

- No Redlib for interactive sessions / MCP `browse_*` — those drive real Reddit in
  Camoufox, unchanged.
- No media proxying; text only.
- No user pages, search, or wiki in v1 (they fall through to the existing chain).

## Design

### Configuration

`WEBFETCH_REDLIB_URL` (e.g. `http://redlib:8080`). Unset → the tier is skipped and
behavior is exactly today's.

### Where it plugs in

`fetchReddit` (`src/reddit.ts`) already resolves share links to the canonical URL, then
tries ordered attempts. When `WEBFETCH_REDLIB_URL` is set, a `tryRedlib` attempt goes
**first** for:

- posts: `/r/<sub>/comments/<id>/…` → `<redlib>/r/<sub>/comments/<id>/…`
- subreddit listings: `/r/<sub>`, `/r/<sub>/<sort>` (with the query string kept, e.g.
  `?t=week`) → the same path on Redlib

Anything else skips the tier.

### Success and fall-through

`tryRedlib` succeeds only on HTTP 200 **and** the expected landmark (a
`.post.highlighted` for a post; at least one `.post` for a listing). Anything else
falls through to the next tier: non-200 (Redlib returns Reddit's status, e.g. 404,
or 5xx when Reddit blocks it), timeout (15 s), connection refused (Redlib down), or a
200 without the landmark. A 404 still falls through — the rest of the chain then
reports the failure the same way it does today.

### Parsing

Redlib's HTML is server-rendered with stable class names, and replies nest as
`blockquote.replies` inside their parent `.comment`. Parse with a real HTML parser
(`node-html-parser`, added with `npm install` — small, no native build) rather than
regexes, since the comment tree is recursive.

### Output

Same shape as the existing JSON/RSS formatters, extended for what Redlib adds:

```
# <title>
r/<sub> · u/<author> · <score> points

<post body as text, links as "text (url)">

## Comments

[u/alice · 11 points]
Comment text…
  [u/bob · 2 points]
  Reply text, indented two spaces per level…
```

Listings:

```
# r/<sub>

- <title> — u/<author> · <score> points · <n> comments
  https://www.reddit.com/r/<sub>/comments/<id>/<slug>/
```

Every link in the output is rewritten from Redlib's relative paths back to
`https://www.reddit.com/…`, so an agent can fetch it again and the internal Redlib
host never leaks. The result's `finalUrl` is the canonical reddit.com URL; `method` is
`reddit-redlib`. The existing 50 000-character cap applies (deep threads are cut there;
Reddit's default "best" ordering means the cut drops the least relevant comments).

## Testing

- Parser unit tests on small **synthetic** fixtures modeled on Redlib's markup (post
  with a nested thread, a listing, an error page) — no real Reddit content checked in.
- `fetchReddit` ordering with a mocked `fetch`: Redlib first when configured; falls
  through on 5xx, 404, timeout, refused, and a 200 without the landmark; not called at
  all when unset; links rewritten to reddit.com.
- The existing gated Reddit integration test gains a Redlib case when
  `WEBFETCH_REDLIB_URL` is set.

## Rollout

1. Redlib service in the webfetch stack (requested from the proxmox agent): pinned
   build, no published port, small `mem_limit`.
2. A `feat:` webfetch release; then the stack gets
   `WEBFETCH_REDLIB_URL=http://redlib:8080`.
3. Verify through `webfetch.home`: a post (method `reddit-redlib`, nested comments), a
   share link, a subreddit listing.
4. README: the env var, and the "bump the Redlib pin when Reddit breaks it" note.
