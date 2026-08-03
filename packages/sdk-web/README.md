# @zinid/sdk-web

Embed ZinID's hosted identity verification flow in your web app.

Your backend mints a session URL; this SDK loads it, manages the iframe, secures the postMessage
channel between your page and the flow, and reports the outcome through a small event API. Three
integration modes — **embed** inline, **modal** overlay, or full-page **redirect**.

Zero runtime dependencies. TypeScript types included. Works in any framework, or none.

## Install

```sh
pnpm add @zinid/sdk-web
# or: npm install @zinid/sdk-web
```

Or load it from a CDN, which exposes a global `ZinID`:

```html
<script src="https://unpkg.com/@zinid/sdk-web"></script>
<script>
  ZinID.createFlow({ url: SESSION_URL }).mount('#zinid');
</script>
```

## Quick start

```js
import { createFlow } from '@zinid/sdk-web';

createFlow({
  url: sessionUrl, // from your backend
  onComplete: ({ session }) => console.log(session.status),
}).mount('#zinid');
```

`sessionUrl` comes from your own backend, which calls the ZinID API. **Never put an API key in the
browser** — the session URL is the only thing the frontend needs.

## React

```tsx
import { useEffect, useRef } from 'react';
import { createFlow } from '@zinid/sdk-web';

export function Verification({ sessionUrl }: { sessionUrl: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const flow = createFlow({
      url: sessionUrl,
      onComplete: ({ session }) => console.log(session.status),
    });
    flow.mount(host.current);
    return () => flow.destroy(); // also covers StrictMode's double-invoke
  }, [sessionUrl]);

  return <div ref={host} />;
}
```

## Svelte

```svelte
<script>
  import { onMount } from 'svelte';
  import { createFlow } from '@zinid/sdk-web';

  export let sessionUrl;
  let host;

  onMount(() => {
    const flow = createFlow({
      url: sessionUrl,
      onComplete: ({ session }) => console.log(session.status),
    });
    flow.mount(host);
    return () => flow.destroy();
  });
</script>

<div bind:this={host}></div>
```

## Vue

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { createFlow } from '@zinid/sdk-web';
import type { ZinIDFlow } from '@zinid/sdk-web';

const props = defineProps<{ sessionUrl: string }>();
const host = ref<HTMLDivElement | null>(null);
let flow: ZinIDFlow | null = null;

onMounted(() => {
  if (!host.value) return;
  flow = createFlow({
    url: props.sessionUrl,
    onComplete: ({ session }) => console.log(session.status),
  });
  flow.mount(host.value);
});

onBeforeUnmount(() => flow?.destroy());
</script>

<template>
  <div ref="host"></div>
</template>
```

## Angular

```ts
import { AfterViewInit, Component, ElementRef, Input, OnDestroy, ViewChild } from '@angular/core';
import { createFlow } from '@zinid/sdk-web';
import type { ZinIDFlow } from '@zinid/sdk-web';

@Component({ selector: 'zinid-verification', standalone: true, template: '<div #host></div>' })
export class VerificationComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) sessionUrl!: string;
  @ViewChild('host') host!: ElementRef<HTMLDivElement>;
  private flow?: ZinIDFlow;

  ngAfterViewInit() {
    this.flow = createFlow({
      url: this.sessionUrl,
      onComplete: ({ session }) => console.log(session.status),
    });
    this.flow.mount(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.flow?.destroy();
  }
}
```

These starters are orientation, not full integrations — see
[the integration guide](https://github.com/Zinary-Analytica-Limited/sdk-zinid/blob/main/docs/INTEGRATION.md)
for complete versions, including a hook for modal and redirect flows.

## Server-side rendering

The SDK is SSR-safe. Importing it at the top level of a module is a no-op on the server: nothing
touches `window` or the DOM until you call `mount()`. Next.js and SvelteKit need no special
handling, no dynamic import and no `typeof window` guard — just create the flow inside an effect or
`onMount`, as above.

## The three modes

**`embed`** (default) puts the flow inline in a container you provide. Best when verification is
part of a page — an onboarding step or a settings panel. The frame fills your container.

```js
createFlow({ url }).mount('#zinid');
```

**`modal`** opens the flow in an overlay above your page. Best when verification interrupts
something else and you want to return the user to where they were.

```js
createFlow({ url, mode: 'modal' }).mount();
```

**`redirect`** navigates the whole page to the flow. Best on mobile web, or when an iframe is
awkward — no frame, and no channel, since your page is gone.

```js
createFlow({ url, mode: 'redirect' }).mount();
```

## Events

Every event can be handled either as an option or with `.on()`. Both register on the same emitter,
so neither shadows the other and both fire.

```js
const flow = createFlow({ url });

flow.on('complete', ({ session }) => console.log(session.status));
flow.off('complete', handler);
```

| Event         | Payload                  | Meaning                                      |
| ------------- | ------------------------ | -------------------------------------------- |
| `ready`       | —                        | The flow has loaded and the channel is live. |
| `step_change` | `{ step, index, total }` | The user moved to another step.              |
| `complete`    | `CompletePayload`        | The session reached a verdict.               |
| `cancel`      | —                        | The user abandoned the flow.                 |
| `error`       | `{ code, message }`      | The session could not reach a verdict.       |

```ts
type CompletePayload = {
  session: { sessionId: string; status: 'Approved' | 'Declined' | 'Pending' };
  type: string;
};
```

**`complete` is an outcome; `error` is a failure.** A `Declined` verification is a _successful_
flow that reached a verdict — it arrives on `complete`, not `error`. `error` means no verdict was
possible: codes are `expired`, `not_found`, `completed` and `unavailable`, plus `invalid_message`,
`unsupported_version` and `close_timeout` from the SDK itself. Branch on `code`, never on
`message`, which is a generic string that will change.

**Both hand the UI decision back to you.** On `complete` and on `error` alike, the SDK reports and
stops — it does not close, replace or restyle anything. If you want the flow dismissed, call
`close()` (keeps the instance, so you can mount it again) or `destroy()` (drops handlers too) from
inside your handler.

Always confirm the outcome server-side, via the API or a webhook, before granting anything. The
browser result is for updating your UI.

## Camera and microphone

The flow needs camera and microphone. The SDK sets the required `allow` attribute on the iframe it
creates, scoped to the ZinID origin — nothing to configure.

**If your site sends a `Permissions-Policy` header, it must permit both for the ZinID origin**, or
the browser strips the permission before it reaches the flow and every user hits a camera-blocked
screen:

```
Permissions-Policy: camera=(self "https://verify.zinid.africa"), microphone=(self "https://verify.zinid.africa")
```

Replace the origin with the origin of the session URL your backend returns. This is a normal
requirement for embedding a camera-using frame, and the failure is silent from your page's side —
worth checking first if verification never starts.

Your site must also be served over **HTTPS**. Browsers only grant camera access in a secure
context; `localhost` counts as secure, so local development works.

## Links

- [GitHub repository](https://github.com/Zinary-Analytica-Limited/sdk-zinid)
- [Integration guide](https://github.com/Zinary-Analytica-Limited/sdk-zinid/blob/main/docs/INTEGRATION.md)
- [Issues](https://github.com/Zinary-Analytica-Limited/sdk-zinid/issues)
