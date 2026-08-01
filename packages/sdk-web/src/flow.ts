/**
 * Flow factory — the vendor-facing entry point.
 *
 * `createFlow` returns a fresh instance every call; there is no singleton, so
 * several flows can run on one page without interfering. Nothing here touches
 * the DOM until `mount()` is called, so importing this module during a server
 * render is safe.
 */

import { Channel, CLOSE_REQUEST, originFromUrl } from './channel';
import { Emitter } from './emitter';
import type {
  ZinIDEventHandler,
  ZinIDEventMap,
  ZinIDEventName,
  ZinIDFlowMode,
  ZinIDFlowOptions,
} from './types';

/**
 * How long to wait for the hosted page to confirm a close request before
 * tearing the UI down anyway, so a user can never be trapped in a modal that
 * an unresponsive flow refuses to close.
 */
export const CLOSE_CONFIRM_TIMEOUT_MS = 2000;

const MODES: ZinIDFlowMode[] = ['embed', 'modal', 'redirect'];

const IFRAME_ALLOW = 'camera; microphone';

const IFRAME_TITLE = 'Identity verification';

/**
 * Floor for the embedded frame, so it never renders at zero and flashes empty
 * when the vendor's container has no intrinsic height. Bounded by the viewport
 * so a short screen is never overflowed.
 */
export const EMBED_MIN_HEIGHT = 480;

/**
 * The modal's tallest box. On a viewport too short for it, the frame falls back
 * to `MODAL_VIEWPORT_CAP` so it never fills the screen edge to edge.
 */
export const MODAL_HEIGHT = 720;

/** Ceiling on a short viewport, leaving the overlay visible around the frame. */
export const MODAL_VIEWPORT_CAP = '95vh';

export interface ZinIDFlow {
  /** Subscribe to an event. Identical in effect to the matching `onX` option. */
  on<K extends ZinIDEventName>(event: K, handler: ZinIDEventHandler<K>): void;
  /** Unsubscribe a handler previously passed to `on`. */
  off<K extends ZinIDEventName>(event: K, handler: ZinIDEventHandler<K>): void;
  /**
   * Present the flow. In embed mode the target is an element or a CSS selector,
   * falling back to `options.container`; modal ignores it; redirect navigates.
   */
  mount(target?: HTMLElement | string): void;
  /** Dismiss the UI but keep the instance and its handlers, so it can be remounted. */
  close(): void;
  /** Dismiss the UI and drop every handler. The instance is spent. */
  destroy(): void;
}

/**
 * Add the parameters the hosted page reads from its own `location.search`.
 *
 * `parent_origin` is not optional: without it the hosted page builds an inert
 * channel and never posts anything — no ready, no complete, silence. The SDK
 * owns this, not the backend, which mints only the bare session URL.
 *
 * This appends to the URL it was given; it never invents one.
 */
export function withFrameParams(sessionUrl: string, mode: ZinIDFlowMode): string {
  const parentOrigin = globalThis.location?.origin;
  if (!parentOrigin || parentOrigin === 'null') {
    throw new Error(
      'The verification flow needs this page to have a real origin, but it has an opaque one ' +
        '(file://, a sandboxed frame, or similar). Serve the page over http or https.',
    );
  }
  const url = new URL(sessionUrl);
  url.searchParams.set('parent_origin', parentOrigin);
  url.searchParams.set('mode', mode);
  return url.toString();
}

function resolveContainer(target: HTMLElement | string): HTMLElement {
  if (typeof target !== 'string') return target;
  const found = document.querySelector(target);
  if (!found) throw new Error(`No element matches the selector ${JSON.stringify(target)}`);
  return found as HTMLElement;
}

function createIframe(url: string, mode: ZinIDFlowMode): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  // The session URL comes from the backend; the SDK only appends the frame
  // params the hosted page requires (see withFrameParams). It never invents a
  // URL, a token, or a path.
  iframe.setAttribute('src', url);
  iframe.setAttribute('title', IFRAME_TITLE);
  iframe.setAttribute('allow', IFRAME_ALLOW);
  // TODO(hardening): add a `sandbox` attribute once the hosted page's exact
  // requirements are known — the wrong token set silently breaks camera access.
  // Both modes are a fixed, viewport-bounded box. The hosted page scrolls its
  // own content, so the SDK never changes these heights after mount.
  iframe.style.cssText =
    mode === 'modal'
      ? // 720px is the ceiling, not a fixed size: a viewport shorter than that
        // clamps to 95vh rather than overflowing or filling the screen entirely.
        `width:100%;height:${MODAL_HEIGHT}px;max-height:${MODAL_VIEWPORT_CAP};` +
        `border:0;display:block;`
      : // Fill the vendor's container, but never collapse to zero when that
        // container has no intrinsic height, and never exceed the viewport.
        `width:100%;height:100%;min-height:min(${EMBED_MIN_HEIGHT}px,100vh);` +
        `max-height:100vh;border:0;display:block;`;
  return iframe;
}

function createOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', IFRAME_TITLE);
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.6);' +
    'display:flex;align-items:center;justify-content:center;';
  // TODO(a11y, required before GA): trap focus inside the overlay while open.
  // Backdrop-click-to-close is deliberately omitted: a stray click must not
  // destroy a half-finished verification.
  return overlay;
}

export function createFlow(options: ZinIDFlowOptions): ZinIDFlow {
  if (!options || typeof options.url !== 'string' || options.url === '') {
    throw new TypeError('createFlow requires a session url issued by your backend.');
  }
  // Parses the URL the vendor supplied; never constructs one.
  const origin = originFromUrl(options.url);
  const mode: ZinIDFlowMode = options.mode ?? 'embed';
  if (!MODES.includes(mode)) {
    throw new TypeError(`Unknown mode ${JSON.stringify(mode)}; expected ${MODES.join(', ')}.`);
  }

  // One emitter per instance. Options-object handlers and `.on()` are both just
  // subscriptions on it, so neither can shadow the other.
  const emitter = new Emitter<ZinIDEventMap>();
  if (options.onReady) emitter.on('ready', options.onReady);
  if (options.onStepChange) emitter.on('step_change', options.onStepChange);
  if (options.onComplete) emitter.on('complete', options.onComplete);
  if (options.onCancel) emitter.on('cancel', options.onCancel);
  if (options.onError) emitter.on('error', options.onError);

  let channel: Channel | undefined;
  let iframe: HTMLIFrameElement | undefined;
  let overlay: HTMLElement | undefined;
  let previousOverflow: string | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let keydownListener: ((event: KeyboardEvent) => void) | undefined;

  function teardownUi(): void {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    if (keydownListener) {
      document.removeEventListener('keydown', keydownListener);
      keydownListener = undefined;
    }
    channel?.destroy();
    channel = undefined;
    overlay?.remove();
    overlay = undefined;
    iframe?.remove();
    iframe = undefined;
    if (previousOverflow !== undefined) {
      document.body.style.overflow = previousOverflow;
      previousOverflow = undefined;
    }
  }

  /**
   * Ask the hosted page to close. The SDK does not synthesise `cancel` — the
   * flow owns that event, and teardown waits for it. The timer is only a
   * safety valve for a page that never answers.
   */
  function requestClose(): void {
    if (!channel || closeTimer !== undefined) return;
    channel.post(CLOSE_REQUEST);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      emitter.emit('error', {
        code: 'close_timeout',
        message: 'The verification flow did not confirm the close request; it was dismissed.',
      });
      teardownUi();
    }, CLOSE_CONFIRM_TIMEOUT_MS);
  }

  // Registered once, up front: the hosted page's cancel is what actually closes
  // a modal. Completion deliberately leaves the UI alone so the vendor can show
  // their own success state and dismiss it with close().
  emitter.on('cancel', () => {
    if (mode === 'modal') teardownUi();
  });

  function mount(target?: HTMLElement | string): void {
    if (mode === 'redirect') {
      globalThis.location.assign(withFrameParams(options.url, mode));
      return;
    }
    if (iframe) return;

    if (mode === 'modal') {
      overlay = createOverlay();
      iframe = createIframe(withFrameParams(options.url, mode), 'modal');
      overlay.append(iframe);
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      document.body.append(overlay);
      keydownListener = (event: KeyboardEvent) => {
        if (event.key === 'Escape') requestClose();
      };
      document.addEventListener('keydown', keydownListener);
    } else {
      const requested = target ?? options.container;
      if (requested === undefined) {
        throw new TypeError(
          'mount() needs a container: pass an element or selector, or set options.container.',
        );
      }
      const container = resolveContainer(requested);
      iframe = createIframe(withFrameParams(options.url, mode), mode);
      container.append(iframe);
    }

    const peer = iframe.contentWindow;
    if (!peer) {
      teardownUi();
      throw new Error('The verification iframe has no content window.');
    }
    channel = new Channel({ emitter, origin, peer, scope: window });
    channel.start();
  }

  return {
    on: (event, handler) => emitter.on(event, handler),
    off: (event, handler) => emitter.off(event, handler),
    mount,
    close: teardownUi,
    destroy: () => {
      teardownUi();
      emitter.clear();
    },
  };
}
