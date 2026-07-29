# Integrating `@zinid/sdk-web` locally

How to consume this SDK from another repo before it is published, and how to wire it into a React
app.

## 1. Get the SDK into your app

The package publishes only `dist/`, and `main`/`module`/`types` all point there, so the SDK must be
**built** before another repo can use it. Every option below handles that.

### Option A — tarball (recommended)

Closest to a real `npm install`: no symlinks, so module resolution behaves exactly as it will in
production.

```sh
# in this repo
cd packages/sdk-web
pnpm pack                      # runs the build first, emits zinid-sdk-web-0.0.0.tgz

# in your React repo
pnpm add /absolute/path/to/sdk-zinid/packages/sdk-web/zinid-sdk-web-0.0.0.tgz
```

Re-run `pnpm pack` and re-install after each SDK change. Deliberate and explicit — good for
verifying a change, tedious for iterating.

### Option B — link (best for iterating)

```sh
# in this repo
cd packages/sdk-web
pnpm build
pnpm link --global

# in your React repo
pnpm link --global @zinid/sdk-web
```

Then leave a watcher running in this repo so every save rebuilds `dist/`:

```sh
pnpm --filter @zinid/sdk-web dev      # tsup --watch
```

Your app's dev server picks up the rebuilt files. Vite sometimes caches linked deps — if a change
does not appear, restart it with `--force`.

To undo: `pnpm unlink --global @zinid/sdk-web` in your app.

### Option C — file: path

In your React repo's `package.json`:

```json
{
  "dependencies": {
    "@zinid/sdk-web": "file:../sdk-zinid/packages/sdk-web"
  }
}
```

Simple, but the path is committed, and you must remember to rebuild `dist/` yourself. Fine for a
throwaway branch, not for anything shared.

## 2. Get a session URL

The SDK never mints sessions. Your backend calls the ZinID API and returns the session URL; the SDK
loads exactly that URL, appending only the frame params it owns (`parent_origin` and `mode`).

Never ship an API key to the browser — the session URL is the only thing the frontend should see.

## 3. React integration

Copy this into your app, e.g. `src/components/ZinIDVerification.tsx`.

```tsx
'use client'; // Next.js App Router only; harmless to delete elsewhere

import { useCallback, useEffect, useRef } from 'react';
import { createFlow } from '@zinid/sdk-web';
import type {
  CompletePayload,
  ErrorPayload,
  StepChangePayload,
  ZinIDFlow,
  ZinIDFlowMode,
} from '@zinid/sdk-web';

interface ZinIDHandlers {
  onReady?: () => void;
  onStepChange?: (payload: StepChangePayload) => void;
  onComplete?: (payload: CompletePayload) => void;
  onCancel?: () => void;
  onError?: (payload: ErrorPayload) => void;
}

/**
 * Inline embed. The iframe sizes itself from the hosted page's resize messages,
 * so give the wrapper a width and let the height look after itself.
 */
export function ZinIDEmbed({
  sessionUrl,
  className,
  ...handlers
}: ZinIDHandlers & { sessionUrl: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const container = containerRef.current;
    if (!sessionUrl || !container) return;

    const flow = createFlow({
      url: sessionUrl,
      mode: 'embed',
      onReady: () => latest.current.onReady?.(),
      onStepChange: (payload) => latest.current.onStepChange?.(payload),
      onComplete: (payload) => latest.current.onComplete?.(payload),
      onCancel: () => latest.current.onCancel?.(),
      onError: (payload) => latest.current.onError?.(payload),
    });
    flow.mount(container);

    // Also runs on React 18 StrictMode's dev double-invoke, which is why the
    // teardown has to be complete: destroy() removes the iframe, closes the
    // postMessage channel and drops every handler.
    return () => flow.destroy();
  }, [sessionUrl]);

  return <div ref={containerRef} className={className} />;
}

/**
 * Modal or redirect, opened by a user action rather than on render — never
 * navigate or throw up an overlay just because a component mounted.
 */
export function useZinIDFlow({
  sessionUrl,
  mode = 'modal',
  ...handlers
}: ZinIDHandlers & { sessionUrl: string | undefined; mode?: ZinIDFlowMode }) {
  const flowRef = useRef<ZinIDFlow | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!sessionUrl) return;

    const flow = createFlow({
      url: sessionUrl,
      mode,
      onReady: () => latest.current.onReady?.(),
      onStepChange: (payload) => latest.current.onStepChange?.(payload),
      onComplete: (payload) => latest.current.onComplete?.(payload),
      onCancel: () => latest.current.onCancel?.(),
      onError: (payload) => latest.current.onError?.(payload),
    });
    flowRef.current = flow;

    return () => {
      flow.destroy();
      flowRef.current = null;
    };
  }, [sessionUrl, mode]);

  return {
    /** Open the modal, or navigate away in redirect mode. */
    open: useCallback(() => flowRef.current?.mount(), []),
    /** Dismiss the UI but keep the instance, so it can be reopened. */
    close: useCallback(() => flowRef.current?.close(), []),
    ready: Boolean(sessionUrl),
  };
}
```

### Using it

```tsx
import { useEffect, useState } from 'react';
import { ZinIDEmbed, useZinIDFlow } from './components/ZinIDVerification';

export function VerifyPage() {
  const [sessionUrl, setSessionUrl] = useState<string>();
  const [status, setStatus] = useState<string>();

  // Your backend mints the session and returns its URL.
  useEffect(() => {
    fetch('/api/verification/session', { method: 'POST' })
      .then((response) => response.json())
      .then((data: { url: string }) => setSessionUrl(data.url));
  }, []);

  if (!sessionUrl) return <p>Preparing verification…</p>;

  return (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
      <ZinIDEmbed
        sessionUrl={sessionUrl}
        onComplete={({ session }) => setStatus(session.status)}
        onCancel={() => setStatus('abandoned')}
        onError={({ code, message }) => console.error('[zinid]', code, message)}
      />
      {status && <p>Result: {status}</p>}
    </div>
  );
}

export function VerifyModalButton({ sessionUrl }: { sessionUrl: string }) {
  const { open } = useZinIDFlow({
    sessionUrl,
    mode: 'modal',
    onComplete: ({ session }) => console.log('done', session.status),
  });

  return <button onClick={open}>Verify my identity</button>;
}
```

### Script tag, if you would rather not bundle

```html
<script src="https://unpkg.com/@zinid/sdk-web"></script>
<script>
  ZinID.createFlow({ url: SESSION_URL, mode: 'modal' }).mount();
</script>
```

## 4. Things that will bite you

**Serve your app over http or https — never `file://`.** The SDK sends its own origin to the hosted
page as `parent_origin`, and the page will only talk back to that exact origin. An opaque origin
throws a clear error at `mount()` rather than hanging. `localhost` is fine.

**Camera needs a secure context in production.** `localhost` counts as secure, so dev is fine, but
a staging site served over plain http on a real hostname will fail at the camera step, not at the
handshake — so it looks like a ZinID problem when it is a TLS problem.

**Outcomes arrive through `onComplete`, not `onError`.** A declined verification is a _successful_
flow with `session.status === 'Declined'`. `onError` is for real failures, and `onCancel` means the
user walked away.

**Never trust the browser's result.** `onComplete` is for updating the UI. Confirm the outcome
server-side via the API or a webhook before granting anything.

**One flow per instance.** `createFlow` returns a new instance every call and there is no
singleton, so several flows can coexist on a page. `close()` dismisses the UI and keeps handlers;
`destroy()` also drops them and spends the instance.

**Handlers passed as options and via `.on()` are the same subscription list** — neither shadows the
other, and both fire.

## 5. Verifying the link worked

If the handshake is broken you will see nothing at all: no events, no errors, an iframe that just
sits there. Check, in order:

1. The iframe's `src` in devtools carries `?parent_origin=<your app's origin>&mode=embed`. Without
   `parent_origin` the hosted page never sends anything.
2. Your app's origin matches that value exactly, including scheme and port.
3. `onError` is wired — an `invalid_message` or `unsupported_version` code means the SDK and the
   hosted page disagree about the wire format, and the SDK version needs updating.
