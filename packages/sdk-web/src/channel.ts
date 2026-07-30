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
import type { CompletePayload, ErrorPayload, StepChangePayload, ZinIDEventMap } from './types';

/**
 * The `zinid:` prefix on `type` *is* the namespacing. There is no `source` tag
 * on the wire in either direction — the envelope is exactly
 * `{ type, payload, v }` — so the prefix is what distinguishes our traffic from
 * everything else that lands on the window.
 */
const TYPE_PREFIX = 'zinid:';

/** Envelope version. Both sides currently speak 1. */
const PROTOCOL_VERSION = 1;

/** Asks the hosted page to tear down. It answers with `zinid:cancel`. */
export const CLOSE_REQUEST = 'zinid:close';

/**
 * Halts the hosted page's ready re-ping. Sent automatically on receipt of
 * `zinid:ready`; the page re-pings with backoff until it hears anything valid.
 */
export const ACK = 'zinid:ack';

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

  /** Set only while listening; also what gates outbound posts. */
  private scope: MessageScope | undefined;

  /** Guards against the ready re-ping surfacing to the vendor more than once. */
  private readyEmitted = false;

  /**
   * Terminal error codes already surfaced. The load-failure page re-pings its
   * error until acknowledged, and a terminal signal must reach the vendor once.
   */
  private terminalErrors = new Set<string>();

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
  }

  /** Begin listening. Calling it again while already listening is a no-op. */
  start(): void {
    if (this.scope) return;
    this.readyEmitted = false;
    this.terminalErrors.clear();
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

  /**
   * Send a message to the hosted page, always addressed to the exact trusted
   * origin. The envelope mirrors the inbound one: `{ type, payload, v }`, with
   * an explicit null payload rather than an absent key.
   */
  post(type: string, payload: unknown = null): void {
    if (!this.scope) return;
    this.peer.postMessage({ type, payload, v: PROTOCOL_VERSION }, this.origin);
  }

  private handleMessage(event: MessageEvent): void {
    // Guard 1: the exact origin, compared whole — a prefix or subdomain match
    // would accept verify.zinid.com.evil.example.
    if (event.origin !== this.origin) return;

    // Guard 2: our own peer window, by identity. Without this, any other frame
    // on the same origin could drive this flow.
    if ((event.source as unknown) !== (this.peer as unknown)) return;

    // Guard 3: our namespace. The window receives plenty of traffic that was
    // never addressed to us, and the `zinid:` prefix on the type is the only
    // thing marking ours — there is no source tag on the wire.
    const data: unknown = event.data;
    if (!isRecord(data) || typeof data.type !== 'string' || !data.type.startsWith(TYPE_PREFIX)) {
      return;
    }

    // The envelope is versioned. An unrecognised version means payload shapes
    // this SDK cannot be trusted to read, so say so rather than misparse them.
    if (data.v !== undefined && data.v !== PROTOCOL_VERSION) {
      this.emitter.emit('error', {
        code: 'unsupported_version',
        message: `The verification flow speaks envelope version ${String(data.v)}; this SDK speaks ${PROTOCOL_VERSION}.`,
      });
      return;
    }

    // Message types are namespaced on the wire. Matching the bare names here
    // silently drops every inbound message, which no unit test using the same
    // wrong string on both sides can catch — hence the E2E contract spec.
    const payload: unknown = data.payload;
    switch (data.type) {
      case 'zinid:ready':
        // The page re-pings ready with backoff until it hears anything valid
        // from us, so acknowledge every ping but surface it to the vendor once.
        this.post(ACK);
        if (this.readyEmitted) return;
        this.readyEmitted = true;
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
        // A terminal failure: the session could not run to a verdict. The
        // load-failure page rides this alongside every ready ping, so
        // acknowledge to stop the re-ping and surface each code only once —
        // a repeated ping must not become repeated onError calls.
        this.post(ACK);
        if (this.terminalErrors.has(payload.code)) return;
        this.terminalErrors.add(payload.code);
        this.emitter.emit('error', payload);
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
