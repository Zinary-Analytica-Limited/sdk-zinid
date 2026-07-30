// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_CONFIRM_TIMEOUT_MS, EMBED_MIN_HEIGHT, MODAL_HEIGHT, createFlow } from './flow';
import type { ZinIDFlow } from './flow';

const URL_ = 'https://verify.zinid.com/s/abc123';
const ORIGIN = 'https://verify.zinid.com';

const COMPLETE_PAYLOAD = {
  session: { sessionId: 'sess_123', status: 'Approved' },
  type: 'identity',
};

/** Deliver a message that clears the channel's origin and source guards. */
function deliverFrom(iframe: HTMLIFrameElement, type: string, payload?: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: ORIGIN,
      source: iframe.contentWindow,
      data: { type, payload: payload ?? null, v: 1 },
    }),
  );
}

function findIframe(root: ParentNode = document): HTMLIFrameElement | null {
  return root.querySelector('iframe');
}

describe('createFlow', () => {
  let flows: ZinIDFlow[];

  beforeEach(() => {
    flows = [];
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const flow of flows) flow.destroy();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Track every flow so afterEach tears it down even when a test fails. */
  function make(options: Parameters<typeof createFlow>[0]): ZinIDFlow {
    const flow = createFlow(options);
    flows.push(flow);
    return flow;
  }

  describe('option validation', () => {
    it('rejects a missing url', () => {
      // @ts-expect-error url is required
      expect(() => createFlow({})).toThrow(/url/i);
    });

    it('rejects a url that is not http or https', () => {
      expect(() => createFlow({ url: 'javascript:alert(1)' })).toThrow(/http/i);
    });

    it('rejects an unparseable url', () => {
      expect(() => createFlow({ url: 'not a url' })).toThrow();
    });

    it('rejects an unknown mode', () => {
      // @ts-expect-error 'popup' is not a supported mode
      expect(() => createFlow({ url: URL_, mode: 'popup' })).toThrow(/mode/i);
    });

    it('fails fast at creation rather than waiting for mount', () => {
      expect(() => createFlow({ url: 'file:///etc/passwd' })).toThrow();
      expect(findIframe()).toBeNull();
    });
  });

  describe('instance semantics', () => {
    it('returns a distinct instance per call, never a singleton', () => {
      const first = make({ url: URL_ });
      const second = make({ url: URL_ });

      expect(first).not.toBe(second);
    });

    it('keeps two flows on one page independent', () => {
      const firstHandler = vi.fn();
      const secondHandler = vi.fn();
      const first = make({ url: URL_, onComplete: firstHandler });
      const second = make({ url: URL_, onComplete: secondHandler });
      const firstHost = document.createElement('div');
      const secondHost = document.createElement('div');
      document.body.append(firstHost, secondHost);
      first.mount(firstHost);
      second.mount(secondHost);

      const firstIframe = findIframe(firstHost);
      expect(firstIframe).not.toBeNull();
      deliverFrom(firstIframe as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(firstHandler).toHaveBeenCalledTimes(1);
      expect(secondHandler).not.toHaveBeenCalled();
    });

    it('does not touch the DOM before mount', () => {
      make({ url: URL_, mode: 'modal' });

      expect(document.body.children.length).toBe(0);
      expect(findIframe()).toBeNull();
    });
  });

  describe('handler wiring', () => {
    it('delivers events to an options-object handler', () => {
      const onComplete = vi.fn();
      const flow = make({ url: URL_, onComplete });
      const host = document.createElement('div');
      document.body.append(host);
      flow.mount(host);

      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(onComplete).toHaveBeenCalledWith(COMPLETE_PAYLOAD);
    });

    it('fires both the options handler and .on() without either shadowing the other', () => {
      // Architectural rule: both register on the same emitter.
      const sugar = vi.fn();
      const subscribed = vi.fn();
      const flow = make({ url: URL_, onComplete: sugar });
      flow.on('complete', subscribed);
      const host = document.createElement('div');
      document.body.append(host);
      flow.mount(host);

      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(sugar).toHaveBeenCalledTimes(1);
      expect(subscribed).toHaveBeenCalledTimes(1);
    });

    it('honours off() for a handler added with on()', () => {
      const handler = vi.fn();
      const flow = make({ url: URL_ });
      flow.on('complete', handler);
      flow.off('complete', handler);
      const host = document.createElement('div');
      document.body.append(host);
      flow.mount(host);

      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(handler).not.toHaveBeenCalled();
    });

    it('wires every sugar handler to its event', () => {
      const onReady = vi.fn();
      const onStepChange = vi.fn();
      const onCancel = vi.fn();
      const onError = vi.fn();
      const flow = make({ url: URL_, onReady, onStepChange, onCancel, onError });
      const host = document.createElement('div');
      document.body.append(host);
      flow.mount(host);
      const iframe = findIframe(host) as HTMLIFrameElement;

      deliverFrom(iframe, 'zinid:ready');
      deliverFrom(iframe, 'zinid:step_change', { step: 'document', index: 1, total: 3 });
      deliverFrom(iframe, 'zinid:cancel');
      deliverFrom(iframe, 'zinid:error', { code: 'camera_denied', message: 'No camera' });

      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onStepChange).toHaveBeenCalledWith({ step: 'document', index: 1, total: 3 });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith({ code: 'camera_denied', message: 'No camera' });
    });

    it('still enforces the origin guard end to end', () => {
      const onComplete = vi.fn();
      const flow = make({ url: URL_, onComplete });
      const host = document.createElement('div');
      document.body.append(host);
      flow.mount(host);

      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evil.example',
          source: (findIframe(host) as HTMLIFrameElement).contentWindow,
          data: { type: 'zinid:complete', payload: COMPLETE_PAYLOAD, v: 1 },
        }),
      );

      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe('embed mode', () => {
    it('is the default mode', () => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_ }).mount(host);

      expect(findIframe(host)).not.toBeNull();
    });

    it('mounts into an element', () => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_, mode: 'embed' }).mount(host);

      expect(findIframe(host)).not.toBeNull();
    });

    it('mounts into a css selector', () => {
      document.body.innerHTML = '<div id="zinid-host"></div>';
      make({ url: URL_ }).mount('#zinid-host');

      expect(findIframe(document.querySelector('#zinid-host') as HTMLElement)).not.toBeNull();
    });

    it('falls back to options.container when mount is called bare', () => {
      const host = document.createElement('div');
      host.id = 'from-options';
      document.body.append(host);
      make({ url: URL_, container: '#from-options' }).mount();

      expect(findIframe(host)).not.toBeNull();
    });

    it('prefers the mount argument over options.container', () => {
      document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
      make({ url: URL_, container: '#a' }).mount('#b');

      expect(findIframe(document.querySelector('#a') as HTMLElement)).toBeNull();
      expect(findIframe(document.querySelector('#b') as HTMLElement)).not.toBeNull();
    });

    it('throws when no target is given and no container is configured', () => {
      expect(() => make({ url: URL_ }).mount()).toThrow(/container|target/i);
    });

    it('throws when the selector matches nothing', () => {
      expect(() => make({ url: URL_ }).mount('#nope')).toThrow(/#nope/);
    });

    it('keeps the session url the backend issued, appending only the frame params', () => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_ }).mount(host);

      const src = new URL((findIframe(host) as HTMLIFrameElement).getAttribute('src') as string);
      const original = new URL(URL_);
      expect(src.origin).toBe(original.origin);
      expect(src.pathname).toBe(original.pathname);
      expect([...src.searchParams.keys()].sort()).toEqual(['mode', 'parent_origin']);
    });

    it('appends parent_origin, without which the hosted page never sends anything', () => {
      // The hosted page reads parent_origin from its own location.search and
      // builds an inert channel if it is absent — a silent, total failure.
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_ }).mount(host);

      const src = new URL((findIframe(host) as HTMLIFrameElement).getAttribute('src') as string);
      expect(src.searchParams.get('parent_origin')).toBe(window.location.origin);
    });

    it.each(['embed', 'modal'] as const)('appends the %s mode', (mode) => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_, mode }).mount(host);

      const src = new URL((findIframe() as HTMLIFrameElement).getAttribute('src') as string);
      expect(src.searchParams.get('mode')).toBe(mode);
    });

    it('preserves query params the backend put on the session url', () => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: `${URL_}?ref=partner123` }).mount(host);

      const src = new URL((findIframe(host) as HTMLIFrameElement).getAttribute('src') as string);
      expect(src.searchParams.get('ref')).toBe('partner123');
      expect(src.searchParams.get('parent_origin')).toBe(window.location.origin);
    });

    it('grants camera and microphone to the hosted page', () => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_ }).mount(host);

      const allow = (findIframe(host) as HTMLIFrameElement).getAttribute('allow') ?? '';
      expect(allow).toMatch(/camera/);
      expect(allow).toMatch(/microphone/);
    });

    it('gives the iframe an accessible title', () => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_ }).mount(host);

      expect((findIframe(host) as HTMLIFrameElement).getAttribute('title')).toBeTruthy();
    });

    it('does not create a second iframe when mounted twice', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);
      flow.mount(host);

      expect(host.querySelectorAll('iframe')).toHaveLength(1);
    });

    it('leaves existing children of the container alone', () => {
      const host = document.createElement('div');
      host.innerHTML = '<p id="kept">loading…</p>';
      document.body.append(host);
      make({ url: URL_ }).mount(host);

      expect(host.querySelector('#kept')).not.toBeNull();
    });
  });

  describe('embed frame sizing', () => {
    function mountEmbed() {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);
      return { flow, host, iframe: findIframe(host) as HTMLIFrameElement };
    }

    it('fills its container rather than taking an explicit pixel height', () => {
      const { iframe } = mountEmbed();

      expect(iframe.style.height).toBe('100%');
    });

    it('is bounded by the viewport', () => {
      const { iframe } = mountEmbed();

      expect(iframe.style.maxHeight).toBe('100vh');
    });

    it('has a floor so it never flashes at zero height', () => {
      // The vendor's container may have no intrinsic height, in which case a
      // bare height:100% would collapse.
      const { iframe } = mountEmbed();

      // Spacing inside min() is normalised differently across engines.
      expect(iframe.style.minHeight).toMatch(
        new RegExp(`min\\(\\s*${EMBED_MIN_HEIGHT}px\\s*,\\s*100vh\\s*\\)`),
      );
    });

    it('carries no height transition, since the height never changes', () => {
      const { iframe } = mountEmbed();

      expect(iframe.style.transition).toBe('');
    });

    it('ignores a stale zinid:resize instead of resizing to it', () => {
      const { iframe } = mountEmbed();

      deliverFrom(iframe, 'zinid:resize', { height: 900 });

      expect(iframe.style.height).toBe('100%');
    });

    it('surfaces no error for a stale zinid:resize', () => {
      const onError = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_, onError });
      flow.mount(host);

      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:resize', { height: 900 });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('error hands control back without touching the UI', () => {
    // zinid:error is a terminal signal, not an outcome. The SDK reports it and
    // stops: it must not dismiss the iframe, tear down the modal, or render
    // anything of its own. Whether to close, replace or keep the surface is the
    // vendor's call, made from inside their handler.
    const LOAD_FAILURE = { code: 'expired', message: 'This link is no longer valid.' };

    it('leaves the embedded iframe in place', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);

      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:error', LOAD_FAILURE);

      expect(findIframe(host)).not.toBeNull();
    });

    it('leaves the modal overlay standing', () => {
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();

      deliverFrom(findIframe() as HTMLIFrameElement, 'zinid:error', LOAD_FAILURE);

      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(findIframe()).not.toBeNull();
    });

    it('keeps the body scroll lock, since the modal is still open', () => {
      document.body.style.overflow = 'auto';
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();

      deliverFrom(findIframe() as HTMLIFrameElement, 'zinid:error', LOAD_FAILURE);

      expect(document.body.style.overflow).toBe('hidden');
    });

    it('renders no message of its own', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);
      const before = host.innerHTML;

      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:error', LOAD_FAILURE);

      expect(host.innerHTML).toBe(before);
    });

    it('leaves the instance usable, so the vendor can close() from the handler', () => {
      const flow = make({
        url: URL_,
        mode: 'modal',
        onError: () => flow.close(),
      });
      flow.mount();

      deliverFrom(findIframe() as HTMLIFrameElement, 'zinid:error', LOAD_FAILURE);

      // Dismissed because the vendor asked, not because the SDK decided.
      expect(findIframe()).toBeNull();
      expect(document.body.style.overflow).not.toBe('hidden');
    });
  });

  describe('modal frame sizing', () => {
    it('holds a fixed box height', () => {
      make({ url: URL_, mode: 'modal' }).mount();

      expect((findIframe() as HTMLIFrameElement).style.height).toBe(`${MODAL_HEIGHT}px`);
    });

    it('does not resize for a stale resize message', () => {
      make({ url: URL_, mode: 'modal' }).mount();
      const iframe = findIframe() as HTMLIFrameElement;

      deliverFrom(iframe, 'zinid:resize', { height: 900 });

      expect(iframe.style.height).toBe(`${MODAL_HEIGHT}px`);
    });
  });

  describe('modal mode', () => {
    it('appends an overlay to the body containing the iframe', () => {
      make({ url: URL_, mode: 'modal' }).mount();

      const iframe = findIframe();
      expect(iframe).not.toBeNull();
      expect(document.body.contains(iframe)).toBe(true);
    });

    it('marks the overlay as a modal dialog for assistive tech', () => {
      make({ url: URL_, mode: 'modal' }).mount();

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
    });

    it('ignores a mount target', () => {
      const host = document.createElement('div');
      document.body.append(host);
      make({ url: URL_, mode: 'modal' }).mount(host);

      expect(findIframe(host)).toBeNull();
      expect(findIframe()).not.toBeNull();
    });

    it('locks body scroll while open and restores it on destroy', () => {
      document.body.style.overflow = 'auto';
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();
      expect(document.body.style.overflow).toBe('hidden');

      flow.destroy();

      expect(document.body.style.overflow).toBe('auto');
    });

    it('ignores keys other than Escape', () => {
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();
      const peer = (findIframe() as HTMLIFrameElement).contentWindow as Window;
      const post = vi.spyOn(peer, 'postMessage');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

      expect(post).not.toHaveBeenCalled();
      expect(findIframe()).not.toBeNull();
    });
  });

  describe('escape closes by asking the hosted page, not by synthesising cancel', () => {
    /** Mount a modal and return its peer window alongside a postMessage spy. */
    function mountModal(options: Partial<Parameters<typeof createFlow>[0]> = {}) {
      const flow = make({ url: URL_, mode: 'modal', ...options });
      flow.mount();
      const iframe = findIframe() as HTMLIFrameElement;
      const peer = iframe.contentWindow as Window;
      return { flow, iframe, post: vi.spyOn(peer, 'postMessage') };
    }

    function pressEscape() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }

    it('posts a close request to the hosted page', () => {
      const { post } = mountModal();

      pressEscape();

      expect(post).toHaveBeenCalledWith({ type: 'zinid:close', payload: null, v: 1 }, ORIGIN);
    });

    it('does not emit cancel itself', () => {
      const onCancel = vi.fn();
      mountModal({ onCancel });

      pressEscape();

      expect(onCancel).not.toHaveBeenCalled();
    });

    it('leaves the overlay up until the hosted page confirms', () => {
      mountModal();

      pressEscape();

      expect(findIframe()).not.toBeNull();
    });

    it('tears down once the hosted page emits cancel', () => {
      const onCancel = vi.fn();
      const { iframe } = mountModal({ onCancel });

      pressEscape();
      deliverFrom(iframe, 'zinid:cancel');

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(findIframe()).toBeNull();
      expect(document.body.style.overflow).not.toBe('hidden');
    });

    it('tears down on a cancel the hosted page raises on its own', () => {
      // The user clicked the hosted page's own close control; no Escape involved.
      const { iframe } = mountModal();

      deliverFrom(iframe, 'zinid:cancel');

      expect(findIframe()).toBeNull();
    });

    it('tears down anyway when the hosted page never confirms', () => {
      vi.useFakeTimers();
      mountModal();

      pressEscape();
      expect(findIframe()).not.toBeNull();
      vi.advanceTimersByTime(CLOSE_CONFIRM_TIMEOUT_MS);

      expect(findIframe()).toBeNull();
    });

    it('reports an error when the fallback teardown fires', () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      mountModal({ onError });

      pressEscape();
      vi.advanceTimersByTime(CLOSE_CONFIRM_TIMEOUT_MS);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'close_timeout' });
    });

    it('does not fire the fallback once cancel has arrived', () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const { iframe } = mountModal({ onError });

      pressEscape();
      deliverFrom(iframe, 'zinid:cancel');
      vi.advanceTimersByTime(CLOSE_CONFIRM_TIMEOUT_MS * 2);

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not stack fallbacks when Escape is pressed repeatedly', () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      mountModal({ onError });

      pressEscape();
      pressEscape();
      pressEscape();
      vi.advanceTimersByTime(CLOSE_CONFIRM_TIMEOUT_MS * 2);

      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('stops listening for Escape once torn down', () => {
      const { iframe, post } = mountModal();
      deliverFrom(iframe, 'zinid:cancel');
      post.mockClear();

      pressEscape();

      expect(post).not.toHaveBeenCalled();
    });

    it('can be reopened after cancelling', () => {
      const { flow, iframe } = mountModal();
      deliverFrom(iframe, 'zinid:cancel');
      expect(findIframe()).toBeNull();

      flow.mount();

      expect(findIframe()).not.toBeNull();
    });
  });

  describe('completion leaves the UI in place', () => {
    it('keeps the modal overlay up so the vendor can show its own success state', () => {
      const onComplete = vi.fn();
      const flow = make({ url: URL_, mode: 'modal', onComplete });
      flow.mount();

      deliverFrom(findIframe() as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(onComplete).toHaveBeenCalledWith(COMPLETE_PAYLOAD);
      expect(findIframe()).not.toBeNull();
    });

    it('keeps the embedded iframe in place', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);

      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(findIframe(host)).not.toBeNull();
    });

    it('is dismissed by the vendor calling close()', () => {
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();
      deliverFrom(findIframe() as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      flow.close();

      expect(findIframe()).toBeNull();
    });
  });

  describe('close', () => {
    it('dismisses the modal overlay and restores scroll', () => {
      document.body.style.overflow = 'auto';
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();

      flow.close();

      expect(document.body.children.length).toBe(0);
      expect(document.body.style.overflow).toBe('auto');
    });

    it('removes the embedded iframe', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);

      flow.close();

      expect(findIframe(host)).toBeNull();
    });

    it('stops delivering messages from the dismissed iframe', () => {
      const onComplete = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_, onComplete });
      flow.mount(host);
      const iframe = findIframe(host) as HTMLIFrameElement;

      flow.close();
      deliverFrom(iframe, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(onComplete).not.toHaveBeenCalled();
    });

    it('keeps handlers subscribed so the flow can be remounted', () => {
      const handler = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.on('complete', handler);
      flow.mount(host);
      flow.close();

      flow.mount(host);
      deliverFrom(findIframe(host) as HTMLIFrameElement, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('is safe before mount', () => {
      expect(() => make({ url: URL_ }).close()).not.toThrow();
    });

    it('is safe twice', () => {
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();

      expect(() => {
        flow.close();
        flow.close();
      }).not.toThrow();
    });
  });

  describe('redirect mode', () => {
    it('navigates the page to the session url', () => {
      const assign = vi.fn();
      vi.stubGlobal('location', { ...window.location, assign });

      make({ url: URL_, mode: 'redirect' }).mount();

      const navigated = new URL(assign.mock.calls[0]?.[0] as string);
      expect(navigated.pathname).toBe(new URL(URL_).pathname);
      expect(navigated.searchParams.get('mode')).toBe('redirect');
      expect(navigated.searchParams.get('parent_origin')).toBe(window.location.origin);
    });

    it('creates no iframe and no overlay', () => {
      vi.stubGlobal('location', { ...window.location, assign: vi.fn() });

      make({ url: URL_, mode: 'redirect' }).mount();

      expect(findIframe()).toBeNull();
      expect(document.body.children.length).toBe(0);
    });

    it('does not listen for messages', () => {
      vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
      const onComplete = vi.fn();
      make({ url: URL_, mode: 'redirect', onComplete }).mount();

      window.dispatchEvent(
        new MessageEvent('message', {
          origin: ORIGIN,
          source: window,
          data: { type: 'zinid:complete', payload: COMPLETE_PAYLOAD, v: 1 },
        }),
      );

      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('removes the embedded iframe', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);

      flow.destroy();

      expect(findIframe(host)).toBeNull();
    });

    it('removes the modal overlay', () => {
      const flow = make({ url: URL_, mode: 'modal' });
      flow.mount();

      flow.destroy();

      expect(document.body.children.length).toBe(0);
    });

    it('stops delivering messages', () => {
      const onComplete = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_, onComplete });
      flow.mount(host);
      const iframe = findIframe(host) as HTMLIFrameElement;

      flow.destroy();
      deliverFrom(iframe, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(onComplete).not.toHaveBeenCalled();
    });

    it('drops handlers registered with on()', () => {
      const handler = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.on('complete', handler);
      flow.mount(host);
      const iframe = findIframe(host) as HTMLIFrameElement;

      flow.destroy();
      deliverFrom(iframe, 'zinid:complete', COMPLETE_PAYLOAD);

      expect(handler).not.toHaveBeenCalled();
    });

    it('is safe before mount', () => {
      expect(() => make({ url: URL_ }).destroy()).not.toThrow();
    });

    it('is safe twice', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const flow = make({ url: URL_ });
      flow.mount(host);

      expect(() => {
        flow.destroy();
        flow.destroy();
      }).not.toThrow();
    });

    it('stops listening for Escape after destroying a modal', () => {
      const onCancel = vi.fn();
      const flow = make({ url: URL_, mode: 'modal', onCancel });
      flow.mount();

      flow.destroy();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});
