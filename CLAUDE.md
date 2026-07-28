# CLAUDE.md — zinid-sdk

## What this repo is

Vendor-facing JavaScript SDK for ZinID's hosted verification flows. Vendors integrate ZinID by
loading our hosted verification page via this SDK, in three modes: **embed** (inline iframe),
**modal** (overlay), and **redirect** (full-page navigation).

The SDK is the **parent-side half of a postMessage channel** with the hosted page. It:

- creates and manages the iframe (embed/modal) or performs the redirect,
- enforces origin security on every message,
- exposes a clean event API to the vendor.

The vendor's backend obtains a **session URL** from the ZinID API; the SDK loads that URL. The SDK
**never constructs flow URLs itself**.

Distributed via npm (`@zinid/sdk-web`) and CDN (unpkg/jsdelivr IIFE bundle). This repo is
standalone — do not read from or assume access to other ZinID repos.

## Layout

pnpm workspace. One package for now:

- `packages/sdk-web` — the SDK (published as `@zinid/sdk-web`).

A future `packages/react` and shared `examples/` fit alongside without restructuring.

## Stack rules

- **TypeScript, strict mode** (see `tsconfig.base.json`). No `any` escapes without justification.
- **Build: tsup**, four outputs from `src/index.ts`:
  - ESM `dist/zinid.js`, CJS `dist/zinid.cjs`, minified IIFE `dist/zinid.min.js` (global name
    `ZinID`), and `.d.ts` declarations.
- **Zero runtime dependencies.** `dependencies` in `packages/sdk-web/package.json` stays empty —
  the SDK uses only browser APIs. Anything needed at build/test time is a devDependency.
- **Size budget: 8KB** minified+gzipped for the IIFE bundle, enforced by size-limit inside the
  `test` script (and therefore in CI). Failing the budget fails the build.
- **Unit tests: Vitest, Node env** — pure logic lives in `.ts` modules and is unit-tested. No
  browser mode, no component/DOM-mount tests beyond what jsdom covers.
- **E2E: Playwright, Chromium only.** Config exists; specs come in a later phase against the
  deployed hosted page.

## Architectural rules (govern all later phases)

1. **Instance-based API.** Entry points return flow instances — never a singleton. Multiple flows
   on one page must not interfere.
2. **SSR-safe.** No `window`/DOM access at module load. All DOM work happens inside method bodies,
   so a top-level import never crashes a server render.
3. **`mount` accepts `HTMLElement | string`** (a CSS selector resolved at mount time).
4. **One emitter.** All event notification funnels through a single emitter per instance, so
   options-object handlers (`onComplete: ...`) and `.on('complete', ...)` never shadow each other —
   both are subscriptions on the same emitter.
5. **The SDK never constructs flow URLs.** It loads the session URL it is given by the vendor
   (which their backend obtained from the ZinID API).

## Workflow rules

- **TDD for vital logic** — emitter, postMessage channel, URL/param construction: write the test
  file first, then **stop for review of the test file** before implementing.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, ...). No AI attribution in commit messages.
- **Commit and push after every phase.**
- **PROGRESS.md**: read it at the start of every session; update it at the end of every session.

## Commands

All from repo root:

- `pnpm build` — tsup, all four outputs
- `pnpm lint` — eslint + prettier check
- `pnpm typecheck` — tsc --noEmit
- `pnpm test` — vitest + size budget (builds first)
