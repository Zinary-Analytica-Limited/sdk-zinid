# Progress

## Phase 0 — Scaffold (complete, 2026-07-27)

- pnpm workspace with `packages/sdk-web` (`@zinid/sdk-web`), laid out so a future
  `packages/react` and shared examples slot in without restructuring.
- TypeScript strict (`tsconfig.base.json`), tsup building four outputs from `src/index.ts`:
  `dist/zinid.js` (ESM), `dist/zinid.cjs` (CJS), `dist/zinid.min.js` (minified IIFE, global
  `ZinID`), `dist/zinid.d.ts`. package.json `exports`/`main`/`module`/`types`/`unpkg`/`jsdelivr`
  wired to them.
- Zero runtime dependencies; size-limit enforces an 8KB minified+gzipped budget on the IIFE
  bundle, wired into the `test` script.
- Vitest (Node env) with a placeholder test; Playwright installed, Chromium-only config, no
  specs yet.
- ESLint (flat config, typescript-eslint) + Prettier.
- `.github/workflows/ci.yml`: install (frozen lockfile) → lint → typecheck → test (includes size
  budget). Node 24, checkout@v5 / setup-node@v5, concurrency cancel-in-progress.
- CLAUDE.md with stack + architectural rules; `.claude/settings.json`.

No SDK logic implemented yet — `src/index.ts` is a placeholder export.

## Phase 1 — Emitter + public types (complete, 2026-07-28)

Built test-first, with the test files reviewed and approved before implementation.

- `src/emitter.ts` — generic typed `Emitter<M>`, the single notification path for the whole SDK.
  Zero dependencies, no DOM, no window; safe to import during a server render.
  - Registration order preserved; duplicate registration of the same function is a no-op, so one
    `off` fully unsubscribes (`EventTarget` semantics, not Node's `EventEmitter`).
  - Mutation during an in-flight emit is well defined: iteration runs over a snapshot, so handlers
    added mid-emit wait for the next one, while each handler is re-checked against the live set, so
    one removed mid-emit does not run at all. Untouched handlers fire exactly once either way.
  - A throwing handler never interrupts the others; its error is re-thrown on a fresh task via
    `setTimeout`, reaching the global error handler with its stack intact rather than being
    swallowed or logged.
  - `clear(event?)` for teardown by the flow instance in a later phase.
  - Generic bound is `M extends object` rather than `Record<string, unknown>` so event maps
    declared as `interface` are accepted (an interface has no implicit index signature).
- `src/types.ts` — public type surface, types only, no runtime code. `SessionStatus` is exactly
  `Approved | Declined | Pending`; the backend collapses "In Review" into `Pending` before it
  reaches the SDK, and a type test guards against that leaking. `CompletePayload` mirrors the
  hosted contract verbatim. `ZinIDFlowOptions` sugar handlers (`onComplete` etc.) are asserted
  structurally identical to their `.on()` equivalents so the two can never drift.
- Tests: 53 passing — `src/emitter.test.ts` (runtime) and `src/types.test-d.ts` (type-level).
  Vitest `typecheck` mode is enabled in `vitest.config.ts`, since `expectTypeOf` and
  `@ts-expect-error` are erased at runtime and would otherwise assert nothing.
- Suite verified by mutation: leaking `'In Review'`, dropping the emit snapshot, and swallowing
  handler errors each fail the suite.

Not wired into `index.ts` — no factory, no channel, no modes, per the phase boundary. The size
budget therefore still measures only the placeholder (366 B gzipped of 8 KB); exporting the
emitter and types measures 533 B, so the budget has ample headroom.

## Phase 2 — postMessage channel with origin guards (complete, 2026-07-28)

Built test-first, with the test file and the wire contract reviewed and approved before
implementation.

- `src/channel.ts` — parent-side half of the channel with the hosted page. No DOM or window access
  at module load or construction; the listener scope and peer window are injected and the scope is
  resolved only inside `start()`, so a server render is safe.
- **Wire envelope** (agreed in review; must stay in step with the hosted page):
  - inbound `{ source: 'zinid', type, payload? }`
  - outbound `{ source: 'zinid-sdk', type, payload? }`
- **Three guards, in order.** Origin must match by exact whole-string comparison; sender must be
  the peer window by identity, so another frame on the same origin cannot drive the flow; envelope
  must carry our tag, since the window receives plenty of unrelated postMessage traffic.
  `Channel` refuses to construct with `'*'`, `''`, or `'null'` as the origin, and `post()` always
  addresses the exact trusted origin, never `'*'`.
- **Malformed-message policy.** Not provably ours (bad tag, wrong shape, non-object) is dropped
  silently. Ours but with a broken payload emits `error` with code `invalid_message` and does not
  emit the original event, so a contract mismatch is loud rather than a silent stall. A well-formed
  message with an _unknown_ type is ignored silently, so a newer hosted page can add events without
  breaking older SDK versions. Consequence to keep in mind: a `complete` carrying `'In Review'`
  fails validation and surfaces as an `error`, by design.
- `originFromUrl(url)` derives the origin to trust from the session URL — parsing only, never
  constructing — and rejects any scheme other than http/https so a `javascript:` or `data:` URL
  cannot become a trusted origin.
- Lifecycle: `start()` is idempotent, `destroy()` is safe before start and safe twice, the channel
  is restartable, and `post()` is gated on being started.
- Tests: 123 passing across `channel.test.ts`, `emitter.test.ts`, `types.test-d.ts`. The guards are
  mutation-verified — removing the origin check, removing the source check, loosening origin
  comparison to a prefix match, posting to `'*'`, skipping the status union, allowing any URL
  scheme, and skipping the envelope tag each fail the suite.

Still not wired into `index.ts` — no factory, no modes. The size budget therefore measures only the
placeholder (366 B of 8 KB); exporting the channel, emitter, and types measures 1.32 kB, so the
budget still has ample headroom.

## Phase 3 — Flow factory and the three modes (complete, 2026-07-28)

Built test-first, with the test file and the interaction decisions reviewed and approved before
implementation.

- `src/flow.ts` — `createFlow(options)` returns a fresh `ZinIDFlow` every call; no singleton, so
  several flows coexist on one page. Nothing touches the DOM until `mount()`, so a top-level import
  is safe during a server render.
- Public instance API: `on`, `off`, `mount(target?)`, `close()`, `destroy()`.
  - `close()` dismisses the UI but keeps the instance and its handlers, so it can be remounted.
  - `destroy()` dismisses the UI **and** clears every handler. The instance is spent.
- Options are validated eagerly in `createFlow` (missing url, non-http scheme, unparseable url,
  unknown mode) rather than deferred to `mount`, so mistakes surface at the call that made them.
- Sugar handlers and `.on()` both subscribe to the one emitter; a test asserts neither shadows the
  other. `mount()`'s argument takes precedence over `options.container`.
- **Embed**: appends an iframe to the target element or CSS selector, leaving existing children
  intact so a vendor's loading placeholder survives. **Modal**: `role="dialog" aria-modal="true"`
  overlay on `body`, with body scroll locked and restored on teardown. **Redirect**:
  `location.assign(url)`, no iframe and no channel.
- The iframe loads the session URL verbatim, with `allow="camera; microphone"` and a title.
- **Escape does not synthesise `cancel`.** It posts `{ source: 'zinid-sdk', type: 'close' }` to the
  hosted page and waits; the flow's own `cancel` is what tears the modal down. A
  `CLOSE_CONFIRM_TIMEOUT_MS` (2s) fallback dismisses the UI and emits an `error` with code
  `close_timeout` if the page never answers, so a user cannot be trapped in a modal. Repeated
  Escape presses do not stack timers.
- **Completion leaves the UI in place** in both embed and modal, so the vendor can show their own
  success state and dismiss it with `close()`. Only `cancel` auto-closes, and only for modal.
- `src/index.ts` now exports the public surface: `createFlow` plus types, nothing else at runtime.
- Tests: 185 passing. The behaviours are mutation-verified — synthesising `cancel` on Escape,
  dropping the auto-close on `cancel`, also auto-closing on `complete`, clearing handlers in
  `close()`, stacking fallback timers, rewriting the session URL, and preferring `options.container`
  over the `mount()` argument each fail the suite.
- All four build outputs verified against the real API: CJS and ESM both export `createFlow`, the
  IIFE still declares the `ZinID` global, and `zinid.d.ts` carries the factory signature. The size
  budget now measures the whole SDK: **2.32 kB gzipped of 8 KB**.

### Deferred, tracked here so they are not lost

- **`sandbox` on the iframe — hardening TODO.** Deliberately not added: the correct token set
  depends on the hosted page's needs, and a wrong one silently breaks camera access. Decide against
  the real hosted page, then add it with a test.
- **Focus trap in the modal — required before GA (accessibility).** The overlay is marked up as a
  dialog but does not yet trap focus, so keyboard and screen-reader users can tab out of it into
  the page behind.
- **Backdrop-click-to-close — intentionally omitted, keep it that way.** A stray click must not
  destroy a half-finished verification.

## Phase 4 — next

End-to-end tests against the deployed hosted page (Playwright, Chromium only — config exists, no
specs yet), plus reconciling the wire envelope with the hosted repo. The envelope
(`{ source: 'zinid' }` inbound, `{ source: 'zinid-sdk' }` outbound, and the `close` request Escape
sends) was defined here without sight of the hosted implementation; every guard works, but if the
shapes disagree nothing gets through. Verify that before writing E2E specs.
