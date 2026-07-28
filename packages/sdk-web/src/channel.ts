/**
 * Parent-side half of the postMessage channel with the hosted verification page.
 *
 * Every inbound message clears three guards before it can reach the emitter:
 * the sending origin must match exactly, the sending window must be our peer,
 * and the envelope must carry our tag. Anything else is not ours and is dropped
 * without a trace.
 *
 * No DOM or window access at module load or construction — the listener scope
 * and the peer window are injected, and the scope is only resolved inside
 * `start()`, so importing this module during a server render is safe.
 */

import type { Emitter } from './emitter';
import type {
  CompletePayload,
  ErrorPayload,
  ResizePayload,
  StepChangePayload,
  ZinIDEventMap,
} from './types';

/** Tag on messages sent by the hosted page. */
const INBOUND_SOURCE = 'zinid';

/** Tag on messages sent by this SDK. */
const OUTBOUND_SOURCE = 'zinid-sdk';

/**
 * Message types are namespaced with a `zinid:` prefix on the wire. The prefix
 * is canonical and owned by the hosted page — never match the bare names.
 */
export const CLOSE_REQUEST = 'zinid:close';

/** Error code used when a message is provably ours but does not match the contract. */
const INVALID_MESSAGE = 'invalid_message';

const STATUSES = ['Approved', 'Declined', 'Pending'];

/** The window hosting the flow: both the only accepted sender and the post target. */
export interface PeerWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** The window whose `message` events we listen to. */
export interface MessageScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface ChannelOptions {
  /** The one emitter every event for this flow funnels through. */
  emitter: Emitter<ZinIDEventMap>;
  /** Exact origin the hosted page must send from. Derive it with `originFromUrl`. */
  origin: string;
  /** The hosted page's window, e.g. `iframe.contentWindow`. */
  peer: PeerWindow;
  /** Listener scope. Defaults to the global object, resolved at `start()`. */
  scope?: MessageScope;
  /**
   * Called when the hosted page reports a settled height. Left unset by modes
   * that hold a fixed box, so an unwanted resize is ignored at the source.
   */
  onResize?: (payload: ResizePayload) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompletePayload(value: unknown): value is CompletePayload {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  const session = value.session;
  return (
    isRecord(session) &&
    typeof session.sessionId === 'string' &&
    typeof session.status === 'string' &&
    STATUSES.includes(session.status)
  );
}

function isStepChangePayload(value: unknown): value is StepChangePayload {
  return (
    isRecord(value) &&
    typeof value.step === 'string' &&
    typeof value.index === 'number' &&
    typeof value.total === 'number'
  );
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

function isResizePayload(value: unknown): value is ResizePayload {
  return isRecord(value) && typeof value.height === 'number' && Number.isFinite(value.height);
}

/**
 * Derive the origin to trust from a session URL.
 *
 * This parses the URL the vendor's backend supplied; it never builds one. Only
 * http and https are accepted, so a `javascript:` or `data:` URL cannot become
 * a trusted origin.
 */
export function originFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`Invalid session URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(
      `Session URL must use http or https, received ${JSON.stringify(parsed.protocol)}`,
    );
  }
  return parsed.origin;
}

export class Channel {
  private readonly emitter: Emitter<ZinIDEventMap>;
  private readonly origin: string;
  private readonly peer: PeerWindow;
  private readonly configuredScope: MessageScope | undefined;
  private readonly onResize: ((payload: ResizePayload) => void) | undefined;

  /** Set only while listening; also what gates outbound posts. */
  private scope: MessageScope | undefined;

  private readonly listener = (event: MessageEvent): void => {
    this.handleMessage(event);
  };

  constructor(options: ChannelOptions) {
    const { origin } = options;
    if (!origin || origin === '*' || origin === 'null') {
      throw new TypeError(
        `Channel requires an exact origin to trust, received ${JSON.stringify(origin)}`,
      );
    }
    this.emitter = options.emitter;
    this.origin = origin;
    this.peer = options.peer;
    this.configuredScope = options.scope;
    this.onResize = options.onResize;
  }

  /** Begin listening. Calling it again while already listening is a no-op. */
  start(): void {
    if (this.scope) return;
    // Resolved here rather than at construction so nothing touches a global
    // during a server render.
    this.scope = this.configuredScope ?? (globalThis as unknown as MessageScope);
    this.scope.addEventListener('message', this.listener);
  }

  /** Stop listening and block outbound posts. Safe before `start` and safe twice. */
  destroy(): void {
    if (!this.scope) return;
    this.scope.removeEventListener('message', this.listener);
    this.scope = undefined;
  }

  /** Send a message to the hosted page, always addressed to the exact trusted origin. */
  post(type: string, payload?: unknown): void {
    if (!this.scope) return;
    const message =
      payload === undefined
        ? { source: OUTBOUND_SOURCE, type }
        : { source: OUTBOUND_SOURCE, type, payload };
    this.peer.postMessage(message, this.origin);
  }

  private handleMessage(event: MessageEvent): void {
    // Guard 1: the exact origin, compared whole — a prefix or subdomain match
    // would accept verify.zinid.com.evil.example.
    if (event.origin !== this.origin) return;

    // Guard 2: our own peer window, by identity. Without this, any other frame
    // on the same origin could drive this flow.
    if ((event.source as unknown) !== (this.peer as unknown)) return;

    // Guard 3: our envelope. The window receives plenty of traffic that was
    // never addressed to us.
    const data: unknown = event.data;
    if (!isRecord(data) || data.source !== INBOUND_SOURCE || typeof data.type !== 'string') return;

    // Message types are namespaced on the wire. Matching the bare names here
    // silently drops every inbound message, which no unit test using the same
    // wrong string on both sides can catch — hence the E2E contract spec.
    const payload: unknown = data.payload;
    switch (data.type) {
      case 'zinid:ready':
        this.emitter.emit('ready');
        return;
      case 'zinid:cancel':
        this.emitter.emit('cancel');
        return;
      case 'zinid:complete':
        if (!isCompletePayload(payload)) return this.reject(data.type);
        this.emitter.emit('complete', payload);
        return;
      case 'zinid:step_change':
        if (!isStepChangePayload(payload)) return this.reject(data.type);
        this.emitter.emit('step_change', payload);
        return;
      case 'zinid:error':
        if (!isErrorPayload(payload)) return this.reject(data.type);
        this.emitter.emit('error', payload);
        return;
      case 'zinid:resize':
        // Not a vendor-facing event: it drives iframe layout, and only the
        // mode that owns a resizable frame subscribes to it.
        if (!isResizePayload(payload)) return this.reject(data.type);
        this.onResize?.(payload);
        return;
      default:
        // A newer hosted page may send events this SDK version predates.
        // Ignoring them keeps old SDKs working against new flows.
        return;
    }
  }

  /**
   * A message that is provably ours but malformed surfaces as an error rather
   * than being dropped, so a contract mismatch is loud instead of looking like
   * a flow that silently stalls.
   */
  private reject(type: string): void {
    this.emitter.emit('error', {
      code: INVALID_MESSAGE,
      message: `Received a malformed "${type}" message from the verification flow.`,
    });
  }
}
