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

## Phase 4 — Wire prefix fix and the embed resize contract (complete, 2026-07-28)

### ⚠️ The channel was fully non-functional before this phase

The hosted page namespaces message types (`zinid:ready`, `zinid:complete`, …). The SDK's inbound
switch matched the **bare** names, so every inbound message fell through to `default` and was
silently discarded. The SDK received nothing from the hosted page — ever.

**Any earlier claim in this file that the channel worked was wrong and must be re-verified end to
end.** Phases 2 and 3 both reported green suites, and both were green against a contract the tests
themselves defined: the unit tests used the same incorrect string on both sides, so they agreed
with the implementation and disagreed with reality. A passing unit test is not evidence that the
channel works. Treat the Phase 2 and Phase 3 "channel working" statements as unverified until
covered by the E2E contract spec.

The same defect existed on the outbound side: Escape posted type `close` rather than `zinid:close`,
so the hosted page's close handler would never have matched and the Escape → cancel loop could not
have completed. Both directions are fixed.

### Fixes and additions

- `channel.ts` now matches the canonical `zinid:*` types, and `CLOSE_REQUEST` (`zinid:close`) is
  exported so the flow cannot re-introduce a bare outbound type.
- **Regression tests spell the wire strings out as literals**, never via a helper shared with the
  implementation — a helper is exactly what let the original bug hide. Unprefixed types are now
  asserted to be _ignored_; an unknown `zinid:*` type is still ignored, preserving forward
  compatibility with a newer hosted page.
- **`zinid:resize` consumed in embed mode.** Guarded by `isResizePayload`, routed to the active
  iframe, and delivered through a `Channel.onResize` consumer rather than the public emitter —
  resize drives layout and is not a vendor-facing event.
  - Height is clamped with `Math.max(height, SDK_MIN_HEIGHT)` (340, confirmed against the hosted
    page's own floor) on the SDK side, mirroring that floor rather than trusting it, so a momentary
    small measurement cannot collapse the frame. The E2E clamp test asserts the number directly
    rather than importing the constant, so changing one without the other fails.
  - The embed iframe carries `transition: height 250ms ease`, so applying a height animates. This
    is the SDK-owned single animation: the iframe animates, the hosted content just changes.
  - Embed starts at `EMBED_INITIAL_HEIGHT` (480) so it never renders at zero and flashes empty; the
    first `zinid:resize` corrects it smoothly.
  - **Modal ignores resize entirely** and holds a fixed `MODAL_HEIGHT` (520) box with internal
    scroll, matching the hosted page's modal policy. It never subscribes, so an unwanted resize is
    ignored at the source. **Redirect** has no iframe and no channel.
- Escape → close → cancel confirmed working now that the prefix is right, both in unit tests and
  end to end.

### E2E contract spec — the thing that can actually catch this

`e2e/channel-contract.spec.ts` runs the **built IIFE bundle** in a real Chromium page against a
hosted-page double, with the two on genuinely different origins (`vendor.test` /
`verify.zinid.test`, served by Playwright route interception, no server needed). The double spells
the `zinid:*` types out by hand. It covers ready, complete-verbatim, step_change, resize apply and
clamp, the full Escape → `zinid:close` → `zinid:cancel` round trip, and a foreign-origin message
being ignored.

**Verified it catches the original bug:** reverting the switch to the bare names fails 6 of the 8
E2E tests. Run with `pnpm --filter @zinid/sdk-web test:e2e` (builds first). Not yet wired into CI —
that needs a `playwright install chromium` step.

- Unit tests: 216 passing. E2E: 8 passing. Size budget: **2.48 kB gzipped of 8 KB**.

### Still deferred

- **`sandbox` on the iframe — hardening TODO.** Now that an E2E double exists, this can be trialled
  against it, though only the real hosted page settles the token set.
- **Focus trap in the modal — required before GA (accessibility).**
- **Backdrop-click-to-close — intentionally omitted, keep it that way.**

## Phase 5 — next

Reconcile the rest of the envelope against the real hosted repo, not just the double: the double
encodes _my_ understanding of the contract, so it can only catch drift between SDK and double, not
a shared misunderstanding of the hosted page. Confirm the `source` tag values (`zinid` inbound,
`zinid-sdk` outbound), the `complete` payload shape, and whether any further `zinid:*` types exist.
Then wire E2E into CI with a browser-install step.
