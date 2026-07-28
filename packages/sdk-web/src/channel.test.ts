import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channel, originFromUrl } from './channel';
import { Emitter } from './emitter';
import type { ZinIDEventMap } from './types';

const ORIGIN = 'https://verify.zinid.com';

/**
 * A stand-in for the window we listen on. Tests run in the Node environment,
 * so there is no real window — the channel takes its listener scope as an
 * injected dependency, which is also what keeps it SSR-safe.
 */
function createScope() {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
      listeners.delete(listener);
    }),
    /** Deliver a raw message event to whatever the channel registered. */
    dispatch(event: { origin?: unknown; source?: unknown; data?: unknown }) {
      for (const listener of [...listeners]) listener(event as unknown as MessageEvent);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** A stand-in for iframe.contentWindow: both the expected sender and the post target. */
function createPeer() {
  return { postMessage: vi.fn() };
}

type Scope = ReturnType<typeof createScope>;
type Peer = ReturnType<typeof createPeer>;

/** A well-formed inbound envelope from the hosted page. */
function message(type: string, payload?: unknown) {
  return payload === undefined ? { source: 'zinid', type } : { source: 'zinid', type, payload };
}

const COMPLETE_PAYLOAD = {
  session: { sessionId: 'sess_123', status: 'Approved' },
  type: 'identity',
};

describe('Channel', () => {
  let scope: Scope;
  let peer: Peer;
  let emitter: Emitter<ZinIDEventMap>;
  let channel: Channel;

  beforeEach(() => {
    scope = createScope();
    peer = createPeer();
    emitter = new Emitter<ZinIDEventMap>();
    channel = new Channel({ emitter, origin: ORIGIN, peer, scope });
  });

  afterEach(() => {
    channel.destroy();
  });

  /** Deliver a message that passes the origin and source guards. */
  function deliver(data: unknown) {
    scope.dispatch({ origin: ORIGIN, source: peer, data });
  }

  describe('construction', () => {
    it('does not attach any listener before start', () => {
      expect(scope.addEventListener).not.toHaveBeenCalled();
      expect(scope.listenerCount).toBe(0);
    });

    it('rejects a wildcard origin', () => {
      // '*' would accept messages from any origin and post secrets to any page.
      expect(() => new Channel({ emitter, origin: '*', peer, scope })).toThrow(/origin/i);
    });

    it('rejects an empty origin', () => {
      expect(() => new Channel({ emitter, origin: '', peer, scope })).toThrow(/origin/i);
    });
  });

  describe('lifecycle', () => {
    it('attaches exactly one message listener on start', () => {
      channel.start();

      expect(scope.addEventListener).toHaveBeenCalledTimes(1);
      expect(scope.addEventListener.mock.calls[0]?.[0]).toBe('message');
      expect(scope.listenerCount).toBe(1);
    });

    it('does not attach a second listener when started twice', () => {
      channel.start();
      channel.start();

      expect(scope.listenerCount).toBe(1);
    });

    it('delivers each message once when started twice', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);
      channel.start();
      channel.start();

      deliver(message('ready'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('removes the listener on destroy', () => {
      channel.start();
      channel.destroy();

      expect(scope.removeEventListener).toHaveBeenCalledTimes(1);
      expect(scope.listenerCount).toBe(0);
    });

    it('ignores messages that arrive after destroy', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);
      channel.start();
      channel.destroy();

      deliver(message('ready'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('is safe to destroy before start', () => {
      expect(() => channel.destroy()).not.toThrow();
    });

    it('is safe to destroy twice', () => {
      channel.start();

      expect(() => {
        channel.destroy();
        channel.destroy();
      }).not.toThrow();
    });

    it('can be restarted after destroy', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);
      channel.start();
      channel.destroy();
      channel.start();

      deliver(message('ready'));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('origin guard', () => {
    beforeEach(() => {
      channel.start();
    });

    it('accepts a message from the exact expected origin', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      deliver(message('ready'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('drops a message from an unrelated origin', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({ origin: 'https://evil.example', source: peer, data: message('ready') });

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a look-alike origin that merely starts with the expected one', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({
        origin: 'https://verify.zinid.com.evil.example',
        source: peer,
        data: message('ready'),
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a subdomain of the expected origin', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({
        origin: 'https://attacker.verify.zinid.com',
        source: peer,
        data: message('ready'),
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a scheme downgrade', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({ origin: 'http://verify.zinid.com', source: peer, data: message('ready') });

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a different port on the expected host', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({
        origin: 'https://verify.zinid.com:8443',
        source: peer,
        data: message('ready'),
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops the opaque "null" origin', () => {
      // A sandboxed iframe or data: document reports origin "null".
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({ origin: 'null', source: peer, data: message('ready') });

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a message with a missing origin', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({ source: peer, data: message('ready') });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('source guard', () => {
    beforeEach(() => {
      channel.start();
    });

    it('drops a message from a different window on the expected origin', () => {
      // Another iframe from the same origin must not be able to drive this flow.
      const handler = vi.fn();
      emitter.on('complete', handler);
      const impostor = createPeer();

      scope.dispatch({
        origin: ORIGIN,
        source: impostor,
        data: message('complete', COMPLETE_PAYLOAD),
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a message with no source', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      scope.dispatch({ origin: ORIGIN, source: null, data: message('ready') });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('envelope validation', () => {
    beforeEach(() => {
      channel.start();
    });

    const notOurs: Array<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['a string', 'ready'],
      ['a number', 42],
      ['an array', [{ source: 'zinid', type: 'ready' }]],
      ['an object with no source tag', { type: 'ready' }],
      ['an object tagged for another sender', { source: 'other-sdk', type: 'ready' }],
      ['an object with a non-string type', { source: 'zinid', type: 7 }],
      ['an object with no type', { source: 'zinid' }],
    ];

    it.each(notOurs)('drops %s without emitting anything', (_label, data) => {
      const handler = vi.fn();
      emitter.on('ready', handler);
      emitter.on('error', handler);

      expect(() => deliver(data)).not.toThrow();

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops a tagged message whose type is not a known event', () => {
      // Silently ignored, not surfaced as an error: a newer hosted page may send
      // event types this SDK version does not know about yet.
      const handler = vi.fn();
      emitter.on('error', handler);

      deliver(message('teleported'));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('event translation', () => {
    beforeEach(() => {
      channel.start();
    });

    it('emits ready', () => {
      const handler = vi.fn();
      emitter.on('ready', handler);

      deliver(message('ready'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits cancel', () => {
      const handler = vi.fn();
      emitter.on('cancel', handler);

      deliver(message('cancel'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits complete with the outcome payload passed through verbatim', () => {
      const handler = vi.fn();
      emitter.on('complete', handler);

      deliver(message('complete', COMPLETE_PAYLOAD));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(COMPLETE_PAYLOAD);
    });

    it.each(['Approved', 'Declined', 'Pending'])('accepts the %s outcome status', (status) => {
      const handler = vi.fn();
      emitter.on('complete', handler);

      deliver(message('complete', { session: { sessionId: 'sess_1', status }, type: 'identity' }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits step_change with its payload', () => {
      const handler = vi.fn();
      emitter.on('step_change', handler);

      deliver(message('step_change', { step: 'document', index: 1, total: 3 }));

      expect(handler).toHaveBeenCalledWith({ step: 'document', index: 1, total: 3 });
    });

    it('emits error with its payload', () => {
      const handler = vi.fn();
      emitter.on('error', handler);

      deliver(message('error', { code: 'camera_denied', message: 'No camera access' }));

      expect(handler).toHaveBeenCalledWith({ code: 'camera_denied', message: 'No camera access' });
    });

    it('emits messages in the order they arrive', () => {
      const seen: string[] = [];
      emitter.on('ready', () => seen.push('ready'));
      emitter.on('step_change', () => seen.push('step_change'));
      emitter.on('complete', () => seen.push('complete'));

      deliver(message('ready'));
      deliver(message('step_change', { step: 'selfie', index: 2, total: 3 }));
      deliver(message('complete', COMPLETE_PAYLOAD));

      expect(seen).toEqual(['ready', 'step_change', 'complete']);
    });
  });

  describe('payload validation', () => {
    beforeEach(() => {
      channel.start();
    });

    /**
     * A message that is provably ours but malformed is surfaced as an `error`
     * event rather than dropped, so a contract mismatch is loud instead of
     * looking like a flow that silently stalls.
     */
    const malformed: Array<[string, unknown]> = [
      ['complete with no payload', message('complete')],
      ['complete with a null session', message('complete', { session: null, type: 'identity' })],
      ['complete with no sessionId', message('complete', { session: { status: 'Approved' } })],
      [
        'complete with a non-string sessionId',
        message('complete', { session: { sessionId: 7, status: 'Approved' }, type: 'identity' }),
      ],
      [
        'complete with a status outside the public union',
        message('complete', {
          session: { sessionId: 'sess_1', status: 'In Review' },
          type: 'identity',
        }),
      ],
      ['step_change with no payload', message('step_change')],
      [
        'step_change with a non-number index',
        message('step_change', { step: 'document', index: '1', total: 3 }),
      ],
      ['error with no payload', message('error')],
      ['error with a non-string code', message('error', { code: 7, message: 'boom' })],
    ];

    it.each(malformed)('emits an error event for %s', (_label, data) => {
      const onError = vi.fn();
      emitter.on('error', onError);

      deliver(data);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'invalid_message' });
      expect(typeof onError.mock.calls[0]?.[0].message).toBe('string');
    });

    it('does not emit the malformed event itself', () => {
      const onComplete = vi.fn();
      emitter.on('complete', onComplete);
      emitter.on('error', vi.fn());

      deliver(message('complete', { session: null, type: 'identity' }));

      expect(onComplete).not.toHaveBeenCalled();
    });

    it('keeps working after a malformed message', () => {
      const onComplete = vi.fn();
      emitter.on('complete', onComplete);
      emitter.on('error', vi.fn());

      deliver(message('complete', { session: null, type: 'identity' }));
      deliver(message('complete', COMPLETE_PAYLOAD));

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(COMPLETE_PAYLOAD);
    });
  });

  describe('post', () => {
    it('posts to the peer using the exact expected origin', () => {
      channel.start();

      channel.post('close');

      expect(peer.postMessage).toHaveBeenCalledTimes(1);
      expect(peer.postMessage.mock.calls[0]?.[1]).toBe(ORIGIN);
    });

    it('never posts with a wildcard target origin', () => {
      channel.start();

      channel.post('close');

      expect(peer.postMessage.mock.calls[0]?.[1]).not.toBe('*');
    });

    it('wraps the outbound message in the sdk envelope', () => {
      channel.start();

      channel.post('close');

      expect(peer.postMessage.mock.calls[0]?.[0]).toEqual({ source: 'zinid-sdk', type: 'close' });
    });

    it('includes the payload when one is given', () => {
      channel.start();

      channel.post('configure', { locale: 'en' });

      expect(peer.postMessage.mock.calls[0]?.[0]).toEqual({
        source: 'zinid-sdk',
        type: 'configure',
        payload: { locale: 'en' },
      });
    });

    it('does not post after destroy', () => {
      channel.start();
      channel.destroy();

      channel.post('close');

      expect(peer.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('instance isolation', () => {
    it('does not deliver one flow’s messages to another flow on the same origin', () => {
      // Architectural rule: two flows on one page must not interfere.
      const otherPeer = createPeer();
      const otherEmitter = new Emitter<ZinIDEventMap>();
      const otherChannel = new Channel({
        emitter: otherEmitter,
        origin: ORIGIN,
        peer: otherPeer,
        scope,
      });
      const handler = vi.fn();
      const otherHandler = vi.fn();
      emitter.on('complete', handler);
      otherEmitter.on('complete', otherHandler);
      channel.start();
      otherChannel.start();

      deliver(message('complete', COMPLETE_PAYLOAD));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(otherHandler).not.toHaveBeenCalled();
      otherChannel.destroy();
    });
  });
});

describe('originFromUrl', () => {
  it('returns the origin of a session url, dropping path and query', () => {
    expect(originFromUrl('https://verify.zinid.com/s/abc123?x=1#f')).toBe(
      'https://verify.zinid.com',
    );
  });

  it('keeps a non-default port', () => {
    expect(originFromUrl('https://localhost:5173/s/abc')).toBe('https://localhost:5173');
  });

  it('drops the default https port', () => {
    expect(originFromUrl('https://verify.zinid.com:443/s/abc')).toBe('https://verify.zinid.com');
  });

  it('lowercases the host', () => {
    expect(originFromUrl('https://VERIFY.ZinID.com/s/abc')).toBe('https://verify.zinid.com');
  });

  it('accepts http for local development', () => {
    expect(originFromUrl('http://localhost:3000/s/abc')).toBe('http://localhost:3000');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'file:///etc/passwd',
    'about:blank',
  ])('rejects the non-http(s) url %s', (url) => {
    expect(() => originFromUrl(url)).toThrow(/http/i);
  });

  it.each(['', 'not a url', '/s/abc', '//verify.zinid.com/s/abc'])(
    'rejects the unparseable url %s',
    (url) => {
      expect(() => originFromUrl(url)).toThrow();
    },
  );
});
