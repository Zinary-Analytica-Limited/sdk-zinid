# Changelog

All notable changes to `@zinid/sdk-web` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-04

Documentation only. **No code changed** — the built output is byte-identical to 0.1.0.

### Fixed

- Corrected the hosted origin in the README's `Permissions-Policy` example from
  `https://verify.zinid.com` to `https://verify.zinid.africa`. Integrators copy that header
  verbatim, and a wrong origin silently denies camera to the verification flow — a failure that
  cannot be diagnosed from the integrating page. 0.1.0 shipped before the correction landed and
  cannot be republished, so the fix ships here.

## [0.1.0] - 2026-08-03

Initial release.

### Added

- `createFlow(options)` — instance-based entry point returning a flow with `on`, `off`,
  `mount(target?)`, `close()` and `destroy()`. No singleton, so several flows can coexist on one
  page.
- Three integration modes: **embed** (inline iframe in a container), **modal** (overlay with a
  viewport-bounded box) and **redirect** (full-page navigation).
- Secured `postMessage` channel with the hosted page. Every inbound message must clear an exact
  origin match, a peer-window identity check, and the `zinid:` type namespace before reaching the
  vendor.
- Events `ready`, `step_change`, `complete`, `cancel` and `error`, delivered through a single
  emitter so options-object handlers and `.on()` subscriptions never shadow each other.
- `complete` carries the verdict (`Approved` / `Declined` / `Pending`); `error` is a terminal
  failure to reach a verdict. Both report and hand the UI decision back to the vendor — the SDK
  never closes or replaces the surface on its own.
- Camera and microphone delegated to the hosted origin via the iframe `allow` attribute, with the
  origin derived from the session URL.
- SSR-safe: no `window` or DOM access at module load, so a top-level import is a no-op on the
  server.
- Zero runtime dependencies. ESM, CJS, a minified IIFE exposing a `ZinID` global for CDN use, and
  TypeScript declarations.

[unreleased]: https://github.com/Zinary-Analytica-Limited/sdk-zinid/compare/main...HEAD
[0.1.1]: https://github.com/Zinary-Analytica-Limited/sdk-zinid/releases/tag/v0.1.1
[0.1.0]: https://github.com/Zinary-Analytica-Limited/sdk-zinid/releases/tag/v0.1.0
