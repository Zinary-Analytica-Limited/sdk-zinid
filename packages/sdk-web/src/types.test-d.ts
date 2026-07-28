import { describe, expectTypeOf, it } from 'vitest';
import { Emitter } from './emitter';
import type {
  CancelPayload,
  CompletePayload,
  ErrorPayload,
  ReadyPayload,
  SessionStatus,
  StepChangePayload,
  ZinIDEventHandler,
  ZinIDEventMap,
  ZinIDEventName,
  ZinIDFlowMode,
  ZinIDFlowOptions,
} from './types';

/**
 * Type-level contract for the public surface. These assertions are erased at
 * runtime — `vitest --typecheck` and `tsc --noEmit` are what actually enforce
 * them, so a failure here shows up as a type error, not a failed assertion.
 */
describe('public event surface', () => {
  it('exposes exactly the flow-agnostic lifecycle events', () => {
    expectTypeOf<ZinIDEventName>().toEqualTypeOf<
      'ready' | 'step_change' | 'complete' | 'cancel' | 'error'
    >();
  });

  it('keys the event map by the event name union', () => {
    expectTypeOf<keyof ZinIDEventMap>().toEqualTypeOf<ZinIDEventName>();
  });

  it('rejects an event name outside the union', () => {
    // @ts-expect-error 'verification_started' is not a public SDK event
    expectTypeOf<ZinIDEventName>().toEqualTypeOf<'verification_started'>();
  });
});

describe('CompletePayload', () => {
  it('matches the canonical outcome shape from the hosted contract verbatim', () => {
    expectTypeOf<CompletePayload>().toEqualTypeOf<{
      session: { sessionId: string; status: SessionStatus };
      type: string;
    }>();
  });

  it('exposes sessionId and status on the nested session object', () => {
    expectTypeOf<CompletePayload['session']['sessionId']>().toEqualTypeOf<string>();
    expectTypeOf<CompletePayload['session']['status']>().toEqualTypeOf<SessionStatus>();
    expectTypeOf<CompletePayload['type']>().toEqualTypeOf<string>();
  });

  it('allows exactly the three public statuses', () => {
    expectTypeOf<SessionStatus>().toEqualTypeOf<'Approved' | 'Declined' | 'Pending'>();
    expectTypeOf<'Approved'>().toExtend<SessionStatus>();
    expectTypeOf<'Declined'>().toExtend<SessionStatus>();
    expectTypeOf<'Pending'>().toExtend<SessionStatus>();
  });

  it('does not leak the internal In Review status', () => {
    // The backend collapses "In Review" to Pending before it reaches the SDK,
    // so it must never appear in the public union.
    // @ts-expect-error 'In Review' is an internal status, never public
    const status: SessionStatus = 'In Review';
    expectTypeOf(status).toEqualTypeOf<SessionStatus>();
  });
});

describe('other event payloads', () => {
  it('describes step_change with step, index and total', () => {
    expectTypeOf<StepChangePayload>().toEqualTypeOf<{
      step: string;
      index: number;
      total: number;
    }>();
  });

  it('describes error with code and message', () => {
    expectTypeOf<ErrorPayload>().toEqualTypeOf<{ code: string; message: string }>();
  });

  it('gives ready and cancel no payload', () => {
    expectTypeOf<ReadyPayload>().toEqualTypeOf<void>();
    expectTypeOf<CancelPayload>().toEqualTypeOf<void>();
  });

  it('maps each event name to its payload', () => {
    expectTypeOf<ZinIDEventMap['ready']>().toEqualTypeOf<ReadyPayload>();
    expectTypeOf<ZinIDEventMap['step_change']>().toEqualTypeOf<StepChangePayload>();
    expectTypeOf<ZinIDEventMap['complete']>().toEqualTypeOf<CompletePayload>();
    expectTypeOf<ZinIDEventMap['cancel']>().toEqualTypeOf<CancelPayload>();
    expectTypeOf<ZinIDEventMap['error']>().toEqualTypeOf<ErrorPayload>();
  });
});

describe('ZinIDEventHandler', () => {
  it('types a handler by the payload of its event', () => {
    expectTypeOf<ZinIDEventHandler<'complete'>>().toEqualTypeOf<
      (payload: CompletePayload) => void
    >();
    expectTypeOf<ZinIDEventHandler<'error'>>().toEqualTypeOf<(payload: ErrorPayload) => void>();
    expectTypeOf<ZinIDEventHandler<'step_change'>>().toEqualTypeOf<
      (payload: StepChangePayload) => void
    >();
  });
});

describe('emitter typing against the public event map', () => {
  const emitter = new Emitter<ZinIDEventMap>();

  it('infers the payload of a handler from the event name', () => {
    emitter.on('complete', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<CompletePayload>();
      expectTypeOf(payload.session.status).toEqualTypeOf<SessionStatus>();
    });

    emitter.on('step_change', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<StepChangePayload>();
    });

    emitter.on('error', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<ErrorPayload>();
    });
  });

  it('rejects an unknown event name', () => {
    // @ts-expect-error 'exploded' is not a member of ZinIDEventMap
    emitter.on('exploded', () => {});
  });

  it('rejects a handler whose payload does not match the event', () => {
    // @ts-expect-error a complete handler cannot take an ErrorPayload
    emitter.on('complete', (payload: ErrorPayload) => void payload);
  });

  it('requires a payload for events that carry one', () => {
    // @ts-expect-error 'complete' cannot be emitted without its payload
    emitter.emit('complete');
  });

  it('takes no payload argument for events that carry none', () => {
    emitter.emit('ready');
    emitter.emit('cancel');
  });
});

describe('ZinIDFlowOptions', () => {
  it('requires the session url supplied by the vendor backend', () => {
    expectTypeOf<ZinIDFlowOptions['url']>().toEqualTypeOf<string>();
  });

  it('accepts the three integration modes', () => {
    expectTypeOf<ZinIDFlowMode>().toEqualTypeOf<'embed' | 'modal' | 'redirect'>();
    expectTypeOf<ZinIDFlowOptions['mode']>().toEqualTypeOf<ZinIDFlowMode | undefined>();
  });

  it('accepts an element or a selector as the mount target', () => {
    expectTypeOf<ZinIDFlowOptions['container']>().toEqualTypeOf<HTMLElement | string | undefined>();
  });

  it('types every sugar handler identically to its .on() equivalent', () => {
    // These register through the same emitter, so the signatures must match
    // exactly — otherwise options-object handlers and .on() would diverge.
    expectTypeOf<NonNullable<ZinIDFlowOptions['onReady']>>().toEqualTypeOf<
      ZinIDEventHandler<'ready'>
    >();
    expectTypeOf<NonNullable<ZinIDFlowOptions['onStepChange']>>().toEqualTypeOf<
      ZinIDEventHandler<'step_change'>
    >();
    expectTypeOf<NonNullable<ZinIDFlowOptions['onComplete']>>().toEqualTypeOf<
      ZinIDEventHandler<'complete'>
    >();
    expectTypeOf<NonNullable<ZinIDFlowOptions['onCancel']>>().toEqualTypeOf<
      ZinIDEventHandler<'cancel'>
    >();
    expectTypeOf<NonNullable<ZinIDFlowOptions['onError']>>().toEqualTypeOf<
      ZinIDEventHandler<'error'>
    >();
  });

  it('makes every sugar handler optional', () => {
    const minimal: ZinIDFlowOptions = { url: 'https://verify.zinid.com/s/abc' };
    expectTypeOf(minimal).toExtend<ZinIDFlowOptions>();
  });

  it('rejects a sugar handler whose payload does not match its event', () => {
    const options: ZinIDFlowOptions = {
      url: 'https://verify.zinid.com/s/abc',
      // @ts-expect-error onComplete receives a CompletePayload, not an ErrorPayload
      onComplete: (payload: ErrorPayload) => void payload,
    };
    expectTypeOf(options).toExtend<ZinIDFlowOptions>();
  });
});
