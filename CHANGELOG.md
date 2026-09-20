# Changelog

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
