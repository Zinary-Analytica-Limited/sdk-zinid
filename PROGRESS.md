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

## Phase 5 — Envelope reconciled against the real hosted page (complete, 2026-07-29)

The hosted repo's actual implementation was supplied (envelope shape, literal outbound objects,
re-ping behaviour, `parent_origin` requirement, Permissions-Policy). Two of my Phase 2 assumptions
were wrong, and **either one alone would have left the channel completely dead in production**.

### Dead channel cause 1 — there is no `source` field

The real envelope is exactly `{ type, payload, v }` in **both** directions. The `zinid:` prefix on
`type` _is_ the namespacing; a separate `source: 'zinid'` tag was my invention and does not exist.
Guard 3 required it, so it would have dropped every inbound message.

Now: discriminate on `type.startsWith('zinid:')`. Outbound mirrors the same envelope, with an
explicit `payload: null` rather than an absent key. The hosted page checks **origin only** on
inbound and ignores everything else, so the `source: 'zinid-sdk'` tag was dropped rather than kept
as decoration.

### Dead channel cause 2 — `parent_origin` is SDK-owned and mandatory

The backend mints only the bare session URL. The SDK must append
`?parent_origin=<its own origin>&mode=<embed|modal|redirect>` before setting `iframe.src`. Without
`parent_origin` the hosted page builds an **inert channel that never posts anything** — no ready,
no complete, silence. This was missing entirely and is the likelier cause of a hung flow.

`withFrameParams()` now adds both, preserving the origin, pathname and any params the backend
already put on the URL. It throws a clear error if the embedding page has an opaque origin
(`file://`, sandboxed frame), where the handshake cannot work at all.

**This changes architectural rule 5 in CLAUDE.md**, which said the SDK never constructs flow URLs.
It still never invents a URL, token or path — but it does own these two params. Rule updated.

### Other corrections

- **Envelope version.** `v` is the literal `1`. An unrecognised version emits an `error` with code
  `unsupported_version` rather than misparsing payloads; a missing `v` is tolerated.
- **Ready re-pings.** The page posts `zinid:ready` immediately then retries with backoff
  (500/1000/2000ms, 3 retries) until it hears anything valid. The SDK now auto-replies `zinid:ack`
  on every ping to halt it, and **surfaces `ready` to the vendor exactly once** — without the
  dedupe a vendor could have seen up to four `ready` events.
- **`zinid:ready` carries `payload: null`**, not `{}`.
- **`CompletePayload` confirmed correct** as built in Phase 1: `session.sessionId` (camelCase),
  `session.status`, and a top-level `type` string (`"completed"` in practice).
- **Outbound surface confirmed complete**: the page acts on exactly `zinid:close` and `zinid:ack`.
  Inbound list of 6 was already exactly right.
- **`allow="camera; microphone"` confirmed required.** The hosted page sets
  `Permissions-Policy: camera=(self "https://verify.didit.me")`, and Didit's camera UI runs in a
  nested cross-origin iframe — without the outer `allow`, the browser strips camera before it ever
  reaches the page. The SDK already had this; it is now known to be load-bearing, not decorative.

### E2E double now mirrors real behaviour

`e2e/channel-contract.spec.ts` was rewritten to match: the real envelope, the ready re-ping loop,
and **going inert without `parent_origin`** — so a missing param is a caught failure rather than a
silent one. 10 tests.

**Mutation-verified against both dead-channel causes:** reinstating the `source` requirement fails
9 of 10; omitting `parent_origin` fails all 10; removing the ack fails 1.

- Unit tests: 230 passing. E2E: 10 passing. Size budget: **2.73 kB gzipped of 8 KB**.

### Still open

- **`sandbox`** remains deliberately absent. Confirmed guidance: if added it needs `allow-scripts`
  and `allow-same-origin` (a fully sandboxed origin cannot hold camera permission); forms, popups
  and downloads are not needed by the hosted page. Whether to sandbox at all still depends on
  Didit's own embed requirements, which nobody here can see.
- **Focus trap** — required before GA (accessibility).
- `static/harness.html` in the hosted repo is the canonical reference embedder and was **not**
  available from this repo, so the SDK has not been diffed against it. Superseded in practice by
  the live run below, but still the better reference if a question comes up.
- The staging host is temporary and must not be hardcoded anywhere.

### Verified against a real hosted session (2026-07-29)

`e2e/live-session.spec.ts` runs the built bundle against an actual staging session over the
network, reading the URL from `VITE_SESSION_URL` (`.env`, gitignored; see `.env.example`) and
skipping entirely when unset. It is deliberately passive — it observes the handshake and never
drives the verification, so it does not consume a session.

The real page's traffic, captured verbatim:

```
{"type":"zinid:ready","payload":null,"v":1}
{"type":"zinid:resize","payload":{"height":402},"v":1}
```

That confirms first-hand, not second-hand: the `{ type, payload, v }` envelope with **no source
field**; `payload: null` on ready; `v` as the literal 1; `zinid:resize` arriving unprompted with a
real height, which the SDK applied (iframe measured 402px). Exactly one `ready` reached the vendor
handler and no `error` fired, so `zinid:ack` did halt the re-ping. The iframe src carried
`parent_origin=https%3A%2F%2Fvendor.test&mode=embed`, and the page was not blocked by
frame-ancestors from a synthetic vendor origin.

**The channel is now confirmed working end to end against production code**, which no previous
phase could claim.

## Local consumption from another repo (2026-07-29)

- `packages/sdk-web` gained `dev` (`tsup --watch`) for iterating against a linked app, and
  `prepack` so `pnpm pack` always ships a freshly built `dist/`. Tarball contents verified: `dist/`
  and `package.json`, nothing else.
- `docs/INTEGRATION.md` covers the three linking options (tarball, `pnpm link --global`, `file:`
  path), a React `ZinIDEmbed` component and `useZinIDFlow` hook, the CDN script tag, and the
  failure modes — opaque origins, secure-context camera, declined-is-not-an-error, server-side
  confirmation.
- The React snippet's logic was type-checked against the real API under `--strict
--exactOptionalPropertyTypes`, so it is known to compile rather than merely reviewed.
- `.env` and `*.tgz` are gitignored; `.env` holds a live session token.

**Not verified:** that the staging page allows embedding from a `localhost` dev origin. The live
E2E run used a synthetic `https://vendor.test` parent via route interception, which the page
accepted, but a real `http://localhost:<port>` origin has not been tried. If the handshake is
silent when integrating, check that first.

## Phase 6 — Resize removed from the contract (complete, 2026-07-30)

**The SDK ↔ hosted contract no longer includes `zinid:resize`.** The hosted flow moved to a fixed,
viewport-bounded frame that scrolls its own content, so per-step height negotiation is obsolete.
Phase 4's resize work is fully reverted.

- `channel.ts`: the `zinid:resize` case, the `isResizePayload` guard and the `onResize` consumer are
  gone, along with `ChannelOptions.onResize`. `ResizePayload` was cleanly unused and removed from
  `types.ts`.
- `flow.ts`: no more `applyResize`, `SDK_MIN_HEIGHT`, `EMBED_INITIAL_HEIGHT`, or the 250ms height
  transition — the animation only existed to smooth resize-driven changes.
- **Embed sizing is now static.** The iframe fills its container
  (`height:100%; max-height:100vh`) with `min-height:min(EMBED_MIN_HEIGHT,100vh)` as a floor, so it
  cannot collapse to zero when the vendor's container has no intrinsic height, and cannot overflow
  a short viewport. `EMBED_MIN_HEIGHT` is 480. No height is ever set after mount.
- **Modal is unchanged** — it already held a fixed `MODAL_HEIGHT` (520) box and never subscribed to
  resize. Confirmed it references nothing resize-related.
- `ready`, `step_change`, `complete`, `cancel` and `error` handling is untouched.
- **A stale `zinid:resize` is a silent no-op.** It now falls through to `default`, so a hosted
  deploy that still broadcasts it produces no `invalid_message` error in the vendor's console and
  no frame movement. Covered by tests at both the channel and flow level, and in the E2E contract
  spec.
- Bundle shrank as expected: **2.73 kB → 2.62 kB gzipped** of 8 KB.
- Unit tests: 220 passing. E2E: 9 passing. Mutation-verified — restoring a fixed pixel height fails
  4 tests, and making resize emit an error instead of being ignored fails 2.

### The live session token expired mid-phase

`VITE_SESSION_URL` now returns **HTTP 410** and the hosted page renders "This link has expired",
sending nothing at all. The live spec was failing with "no ready received", which is
indistinguishable from a broken handshake. It now checks the session document's status first and
**skips with a clear message** when it is not 200, so a stale fixture cannot masquerade as a
product regression. Put a fresh URL in `.env` to re-enable it.

~~Worth noting for the product: an expired session is silent on the wire.~~ **No longer true** — see
Phase 7. The hosted page now runs a minimal channel on its load-failure screen and reports the
reason. The observation held only against the deploy of 2026-07-30.

## Phase 7 — The `zinid:error` contract (complete, 2026-07-30)

`zinid:error` is the **failure channel**, not an outcome: every real verdict (Approved, Declined,
Pending) arrives on `complete`. It means the session could not run to a verdict at all.

### The SDK reports and hands back control — it never touches the UI

On `zinid:error` the SDK fires the vendor's handler and **stops**. It does not dismiss the iframe,
tear down the modal, drop the body scroll lock, or render anything of its own. Whether to close,
replace or keep the surface is the vendor's decision, made from inside their handler with `close()`
or `destroy()` — tools the SDK offers, never actions it takes.

The implementation already behaved this way (only `cancel` triggers teardown), but nothing asserted
it, so a future change could have broken it silently. Now covered by five tests, and
mutation-verified: making `error` tear down the UI fails 4 of them.

### Terminal errors are surfaced once

The load-failure page rides `zinid:error` alongside every `zinid:ready` ping, re-pinging until the
SDK acks. The channel now acknowledges on `zinid:error` as well as on `ready`, and deduplicates by
`code`, so a burst before the ack lands cannot become a burst of `onError` calls. Deduping is per
code, not blanket, so a genuinely different failure still gets through; the set clears on restart.
Mutation-verified — removing the dedupe fails 2 tests.

### Codes

Terminal load failures: `expired` | `not_found` | `completed` | `unavailable`. SDK-generated:
`invalid_message`, `unsupported_version`, `close_timeout`. `ErrorPayload.code` stays a plain
`string` rather than a union **on purpose** — narrowing it would make any new hosted code a
compile error for vendors and force an SDK release. Branch on `code`, never on `message`, which is
a generic non-leaky string.

A mid-flow Didit session expiry is _not_ an error — it is a flow outcome and arrives on the verdict
path.

### Verified against real staging

With the hosted changes deployed, the expired token in `.env` produced, verbatim:

```
{"type":"zinid:ready","payload":null,"v":1}
{"type":"zinid:error","payload":{"code":"expired","message":"This verification session has expired."},"v":1}
```

`onError` fired exactly once with `code: 'expired'`, and the iframe was still present afterwards.

`e2e/live-session.spec.ts` now has two tests that route on the session document's HTTP status: a
live session (200) exercises the handshake, an expired one (410) exercises the terminal-error path.
**An expired token is a permanently stable fixture**, so the current `.env` keeps earning its keep
rather than merely going stale.

- Unit tests: 235 passing. E2E: 9 contract + 1 live error path, 1 skipped (needs a live token).

## Phase 8 — next

1. **Wire E2E into CI** with a `playwright install chromium` step. The contract spec needs no
   secrets; the live spec skips without `VITE_SESSION_URL` and should stay opt-in so CI never
   depends on a session token.
2. **Focus trap** for the modal, required before GA.
3. Decide the `sandbox` question against Didit's embed requirements.
4. Exercise a **terminal outcome** against a live session — the passive run confirmed only the
   handshake, and `zinid:complete` and `zinid:cancel` have still only been seen from the double.
   That needs a fresh token and a session someone actually completes.
