/**
 * Public type surface for @zinid/sdk-web.
 *
 * Types only — this module emits no runtime code and touches no DOM or window,
 * so importing it is safe during a server render.
 *
 * Payload shapes are declared as type aliases rather than interfaces so they
 * compare structurally (and so `ZinIDEventMap` satisfies the emitter's
 * `Record<string, unknown>` constraint, which an interface would not).
 */

/**
 * Outcome status of a verification session, as the vendor sees it.
 *
 * These three are the whole public union. The backend collapses its internal
 * "In Review" state into `Pending` before the outcome ever reaches the SDK, so
 * "In Review" must never appear here.
 */
export type SessionStatus = 'Approved' | 'Declined' | 'Pending';

/**
 * Canonical outcome shape from the hosted verification page, passed through
 * verbatim. The SDK does not reshape, rename, or flatten it.
 */
export type CompletePayload = {
  session: {
    sessionId: string;
    status: SessionStatus;
  };
  type: string;
};

/** Emitted when the flow advances between steps of the hosted page. */
export type StepChangePayload = {
  /** Machine-readable identifier of the step now showing. */
  step: string;
  /** Zero-based position of the current step. */
  index: number;
  /** Total number of steps in the flow. */
  total: number;
};

/** Emitted when the flow fails. */
export type ErrorPayload = {
  code: string;
  message: string;
};

/** The hosted page has loaded and the channel is live. Carries no payload. */
export type ReadyPayload = void;

/** The user abandoned the flow. Carries no payload. */
export type CancelPayload = void;

/**
 * Every event the SDK exposes. The lifecycle is flow-agnostic; `step_change` is
 * verification-specific for now but belongs to the same surface.
 */
export type ZinIDEventMap = {
  ready: ReadyPayload;
  step_change: StepChangePayload;
  complete: CompletePayload;
  cancel: CancelPayload;
  error: ErrorPayload;
};

/** Name of any event the SDK exposes. */
export type ZinIDEventName = keyof ZinIDEventMap;

/** Handler for a given event, typed by that event's payload. */
export type ZinIDEventHandler<K extends ZinIDEventName> = (payload: ZinIDEventMap[K]) => void;

/** How the hosted flow is presented to the user. */
export type ZinIDFlowMode = 'embed' | 'modal' | 'redirect';

/**
 * Options accepted by the flow factory.
 *
 * The `onX` handlers are sugar for `.on('x', handler)` — they register through
 * the same emitter, so their signatures are identical to the `.on()` forms and
 * neither shadows the other.
 */
export interface ZinIDFlowOptions {
  /**
   * Session URL obtained by the vendor's backend from the ZinID API. The SDK
   * loads this URL as given and never constructs a flow URL itself.
   */
  url: string;
  /** Presentation mode. Defaults are applied by the factory in a later phase. */
  mode?: ZinIDFlowMode;
  /** Mount target for embed mode: an element, or a CSS selector resolved at mount time. */
  container?: HTMLElement | string;
  onReady?: ZinIDEventHandler<'ready'>;
  onStepChange?: ZinIDEventHandler<'step_change'>;
  onComplete?: ZinIDEventHandler<'complete'>;
  onCancel?: ZinIDEventHandler<'cancel'>;
  onError?: ZinIDEventHandler<'error'>;
}
