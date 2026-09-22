# Changelog

## [0.5.0](https://github.com/bbaldino/webfetch/compare/v0.4.0...v0.5.0) (2026-09-22)


### Features

* CookieJar — hot-reloaded jar with scoped write-back ([188a633](https://github.com/bbaldino/webfetch/commit/188a6331453010e913ac89af775e82e61d42e6c2))
* detect bot-protection walls and phrase block notices ([9fc3f42](https://github.com/bbaldino/webfetch/commit/9fc3f42e3b01d15686faf18575484c2c7bc14109))
* export-cookies CLI to build a jar from desktop Chrome ([c73bc2d](https://github.com/bbaldino/webfetch/commit/c73bc2d200a1963002ce304975038aec393561ba))
* seed every browser context from the cookie jar ([63b7d06](https://github.com/bbaldino/webfetch/commit/63b7d068aace5e2cb77ea0a12626563e1c1f3beb))


### Bug Fixes

* BrowserManager — ordered write-back tests, track temp contexts, idempotent close ([942bfca](https://github.com/bbaldino/webfetch/commit/942bfcaa24ec89c0fbe5b5a67062ca9fc99f7125))
* cookie-jar reload, write-back and coverage edge cases ([f6071ec](https://github.com/bbaldino/webfetch/commit/f6071ec3241de098c68dfb1d530991680c46c664))
* CookieJar — don't drop a merge racing an in-flight write ([490d216](https://github.com/bbaldino/webfetch/commit/490d2167b29fef98c48348cf7b7aa2b7e71cf1fb))
* export-cookies — copy WAL sidecars, tighten error handling ([420259a](https://github.com/bbaldino/webfetch/commit/420259a932ffa347469923cc8434022116857aec))
* export-cookies rejects a non-array jar and never writes at 0644 ([0de9d0c](https://github.com/bbaldino/webfetch/commit/0de9d0cffa989c0baf150de7390dde3b1cb9ccec))
* report bot walls and empty pages as errors, not empty successes ([9d64c37](https://github.com/bbaldino/webfetch/commit/9d64c37f5901d6b564642a1159d32f02b1090b03))
* treat short bot-wall pages and MCP fetch failures as errors ([d1b5561](https://github.com/bbaldino/webfetch/commit/d1b5561a012c757c050e5d7f494488b65f149c9d))
* validate jar cookies one by one so a bad entry can't void the jar ([374e49d](https://github.com/bbaldino/webfetch/commit/374e49d3dd1fd7ae37bd3469360d16e64875bf0c))
* write back only cookies a context changed, not its seed copy ([b4d1e2d](https://github.com/bbaldino/webfetch/commit/b4d1e2d568325976b89156664a4dae9a760e3c39))

## [0.4.0](https://github.com/bbaldino/webfetch/compare/v0.3.0...v0.4.0) (2026-09-22)


### Features

* McpFace — HTTP MCP with per-client capped browse sessions ([327bb94](https://github.com/bbaldino/webfetch/commit/327bb94a016bf678907671c234091b716f76db6e))
* mount the MCP endpoint at /mcp on the webfetch server ([aa20718](https://github.com/bbaldino/webfetch/commit/aa20718bfaccd7cb2cc85c0f345b20eb9feeb037))
* shared browse-tool dispatch; add browse_wait and navigate wait_for ([bb03938](https://github.com/bbaldino/webfetch/commit/bb03938222bfc92c1b2be0e2fbc52873ba2d502e))


### Bug Fixes

* address final-review findings for the MCP endpoint ([94ba692](https://github.com/bbaldino/webfetch/commit/94ba6928988d95f297f4b821ece00e0cb850ff36))
* clean 400 for malformed /mcp JSON body; extract parseAllowedHosts ([6462081](https://github.com/bbaldino/webfetch/commit/64620814ebbdb4c532e479e163ad883331ec0bc2))
* correct MCP tool names in README (browse_go_back/select_option/press_key) ([82929c6](https://github.com/bbaldino/webfetch/commit/82929c63df09526d166580ba534db6a2493ff395))

## [0.3.0](https://github.com/bbaldino/webfetch/compare/v0.2.3...v0.3.0) (2026-09-20)


### Features

* add BrowseController with the shared browse operations ([5059301](https://github.com/bbaldino/webfetch/commit/505930150753c30edf9b388d243ece470f8a25b0))
* add HTTP session routes for interactive browsing ([f59f174](https://github.com/bbaldino/webfetch/commit/f59f174b719f3f0876d964e69b748d20ff775eae))
* add SessionManager (cap, idle TTL, per-session serialization) ([aca3e28](https://github.com/bbaldino/webfetch/commit/aca3e28604abd49e8e8ea7f5b2add43b862b1ca6))
* serve an OpenAPI 3.1 spec at GET /openapi.json ([e088bdb](https://github.com/bbaldino/webfetch/commit/e088bdba04e5433039be05a0892ef6209d9bf5f0))


### Bug Fixes

* address final-review findings for browse sessions ([075304e](https://github.com/bbaldino/webfetch/commit/075304e6b799d8ff84dffb97bb5aae98220553ed))
* pause idle timer during session operations and test evicted-while-queued case ([161f0e2](https://github.com/bbaldino/webfetch/commit/161f0e2c2f651bbd01aeb8275758968f647b313d))
* validate select values and wait_for shape in session routes ([0380ff4](https://github.com/bbaldino/webfetch/commit/0380ff4e57807bd8a691a8ce0f7081e75695c13b))

## [0.2.3](https://github.com/bbaldino/webfetch/compare/v0.2.2...v0.2.3) (2026-09-19)


### Bug Fixes

* clean stray tag fragments from scraped Reddit text; add a 404 route hint ([#5](https://github.com/bbaldino/webfetch/issues/5)) ([865eccd](https://github.com/bbaldino/webfetch/commit/865eccdc179932844f289ce96d868b1f8408b06e))

## [0.2.2](https://github.com/bbaldino/webfetch/compare/v0.2.1...v0.2.2) (2026-09-16)


### Bug Fixes

* stop the Reddit chain returning 404 feeds and nav-chrome as content ([#3](https://github.com/bbaldino/webfetch/issues/3)) ([b7daea0](https://github.com/bbaldino/webfetch/commit/b7daea0fa4d96938a4a636f56749e76d9fae9d8f))

## [0.2.1](https://github.com/bbaldino/webfetch/compare/v0.2.0...v0.2.1) (2026-09-14)


### Bug Fixes

* build native deps in a builder stage and run under tini ([6030b71](https://github.com/bbaldino/webfetch/commit/6030b7168c5cd5f04ad7600984414b63beb295a1))

## [0.2.0](https://github.com/bbaldino/webfetch/compare/v0.1.0...v0.2.0) (2026-09-14)


### Features

* initial webfetch service with release-tagging CI ([695fef6](https://github.com/bbaldino/webfetch/commit/695fef6ebceeef5db96a44118316c7a0f2a665ed))
