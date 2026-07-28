import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from './emitter';

/**
 * A local event map keeps these runtime tests readable and independent of the
 * public SDK event surface (which is asserted separately in types.test-d.ts).
 * `pong` carries no payload, exercising the void-payload path.
 */
interface TestEvents {
  ping: { n: number };
  pong: void;
}

describe('Emitter', () => {
  let emitter: Emitter<TestEvents>;

  beforeEach(() => {
    emitter = new Emitter<TestEvents>();
  });

  describe('on / emit', () => {
    it('calls a registered handler with the emitted payload', () => {
      const handler = vi.fn();
      emitter.on('ping', handler);

      emitter.emit('ping', { n: 1 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ n: 1 });
    });

    it('supports a single handler as the common case', () => {
      const handler = vi.fn();
      emitter.on('ping', handler);

      emitter.emit('ping', { n: 7 });
      emitter.emit('ping', { n: 8 });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, { n: 7 });
      expect(handler).toHaveBeenNthCalledWith(2, { n: 8 });
    });

    it('calls every handler registered for an event, in registration order', () => {
      const calls: string[] = [];
      emitter.on('ping', () => calls.push('first'));
      emitter.on('ping', () => calls.push('second'));
      emitter.on('ping', () => calls.push('third'));

      emitter.emit('ping', { n: 1 });

      expect(calls).toEqual(['first', 'second', 'third']);
    });

    it('passes the same payload reference to every handler', () => {
      const payload = { n: 42 };
      const first = vi.fn();
      const second = vi.fn();
      emitter.on('ping', first);
      emitter.on('ping', second);

      emitter.emit('ping', payload);

      expect(first.mock.calls[0]?.[0]).toBe(payload);
      expect(second.mock.calls[0]?.[0]).toBe(payload);
    });

    it('registers a handler only once when the same function is added twice', () => {
      const handler = vi.fn();
      emitter.on('ping', handler);
      emitter.on('ping', handler);

      emitter.emit('ping', { n: 1 });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not leak handlers across event names', () => {
      const pingHandler = vi.fn();
      const pongHandler = vi.fn();
      emitter.on('ping', pingHandler);
      emitter.on('pong', pongHandler);

      emitter.emit('ping', { n: 1 });

      expect(pingHandler).toHaveBeenCalledTimes(1);
      expect(pongHandler).not.toHaveBeenCalled();
    });

    it('does not leak handlers across emitter instances', () => {
      // Architectural rule: the SDK is instance-based, so two flows on one page
      // must never observe each other's events.
      const other = new Emitter<TestEvents>();
      const handler = vi.fn();
      const otherHandler = vi.fn();
      emitter.on('ping', handler);
      other.on('ping', otherHandler);

      emitter.emit('ping', { n: 1 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(otherHandler).not.toHaveBeenCalled();
    });

    it('emits an event that carries no payload', () => {
      const handler = vi.fn();
      emitter.on('pong', handler);

      emitter.emit('pong');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('off', () => {
    it('removes only the specified handler and leaves the others intact', () => {
      const removed = vi.fn();
      const kept = vi.fn();
      emitter.on('ping', removed);
      emitter.on('ping', kept);

      emitter.off('ping', removed);
      emitter.emit('ping', { n: 1 });

      expect(removed).not.toHaveBeenCalled();
      expect(kept).toHaveBeenCalledTimes(1);
    });

    it('preserves registration order of the remaining handlers', () => {
      const calls: string[] = [];
      const second = () => calls.push('second');
      emitter.on('ping', () => calls.push('first'));
      emitter.on('ping', second);
      emitter.on('ping', () => calls.push('third'));

      emitter.off('ping', second);
      emitter.emit('ping', { n: 1 });

      expect(calls).toEqual(['first', 'third']);
    });

    it('is a no-op when removing a handler that was never registered', () => {
      const registered = vi.fn();
      emitter.on('ping', registered);

      expect(() => emitter.off('ping', vi.fn())).not.toThrow();
      emitter.emit('ping', { n: 1 });

      expect(registered).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when removing from an event with no handlers', () => {
      expect(() => emitter.off('ping', vi.fn())).not.toThrow();
    });
  });

  describe('emitting with no handlers', () => {
    it('does not throw when nothing is registered for the event', () => {
      expect(() => emitter.emit('ping', { n: 1 })).not.toThrow();
    });

    it('does not throw after every handler has been removed', () => {
      const handler = vi.fn();
      emitter.on('ping', handler);
      emitter.off('ping', handler);

      expect(() => emitter.emit('ping', { n: 1 })).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('handler error isolation', () => {
    // A throwing handler is re-thrown on a fresh task rather than swallowed, so
    // it reaches window.onerror / the global error handler without interrupting
    // the emit loop. Fake timers hold those scheduled throws so they can be
    // asserted here instead of escaping into the test run.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs the remaining handlers when an earlier handler throws', () => {
      const boom = vi.fn(() => {
        throw new Error('handler blew up');
      });
      const after = vi.fn();
      emitter.on('ping', boom);
      emitter.on('ping', after);

      expect(() => emitter.emit('ping', { n: 1 })).not.toThrow();

      expect(boom).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
    });

    it('re-throws the handler error asynchronously, preserving the original error', () => {
      const error = new Error('handler blew up');
      emitter.on('ping', () => {
        throw error;
      });

      emitter.emit('ping', { n: 1 });

      expect(() => vi.runAllTimers()).toThrow(error);
    });

    it('does not re-throw synchronously during the emit', () => {
      const error = new Error('handler blew up');
      const after = vi.fn();
      emitter.on('ping', () => {
        throw error;
      });
      emitter.on('ping', after);

      // The emit itself completes cleanly; the throw is still pending.
      emitter.emit('ping', { n: 1 });
      expect(after).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('re-throws each handler error separately when several handlers throw', () => {
      const first = new Error('first blew up');
      const second = new Error('second blew up');
      const healthy = vi.fn();
      emitter.on('ping', () => {
        throw first;
      });
      emitter.on('ping', () => {
        throw second;
      });
      emitter.on('ping', healthy);

      emitter.emit('ping', { n: 1 });

      expect(healthy).toHaveBeenCalledTimes(1);
      expect(() => vi.advanceTimersToNextTimer()).toThrow(first);
      expect(() => vi.advanceTimersToNextTimer()).toThrow(second);
    });

    it('re-throws a non-Error thrown value unchanged', () => {
      emitter.on('ping', () => {
        throw 'a bare string';
      });

      emitter.emit('ping', { n: 1 });

      expect(() => vi.runAllTimers()).toThrow('a bare string');
    });

    it('keeps working for subsequent emits after a handler throws', () => {
      const boom = vi.fn(() => {
        throw new Error('handler blew up');
      });
      const healthy = vi.fn();
      emitter.on('ping', boom);
      emitter.on('ping', healthy);

      emitter.emit('ping', { n: 1 });
      emitter.emit('ping', { n: 2 });

      expect(boom).toHaveBeenCalledTimes(2);
      expect(healthy).toHaveBeenCalledTimes(2);
    });
  });

  describe('mutation during an in-flight emit', () => {
    it('does not call a handler removed by an earlier handler in the same emit', () => {
      const later = vi.fn();
      emitter.on('ping', () => emitter.off('ping', later));
      emitter.on('ping', later);

      emitter.emit('ping', { n: 1 });

      expect(later).not.toHaveBeenCalled();
    });

    it('still calls the untouched handlers exactly once when one is removed mid-emit', () => {
      const removed = vi.fn();
      const untouched = vi.fn();
      emitter.on('ping', () => emitter.off('ping', removed));
      emitter.on('ping', removed);
      emitter.on('ping', untouched);

      emitter.emit('ping', { n: 1 });

      expect(removed).not.toHaveBeenCalled();
      expect(untouched).toHaveBeenCalledTimes(1);
    });

    it('does not call a handler added during the emit that added it', () => {
      const added = vi.fn();
      emitter.on('ping', () => emitter.on('ping', added));

      emitter.emit('ping', { n: 1 });
      expect(added).not.toHaveBeenCalled();

      emitter.emit('ping', { n: 2 });
      expect(added).toHaveBeenCalledTimes(1);
    });

    it('supports once-style self-removal from inside a handler', () => {
      const handler = vi.fn(() => {
        emitter.off('ping', handler);
      });
      emitter.on('ping', handler);

      emitter.emit('ping', { n: 1 });
      emitter.emit('ping', { n: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not double-fire a handler re-registered during its own emit', () => {
      const handler = vi.fn(() => {
        emitter.off('ping', handler);
        emitter.on('ping', handler);
      });
      emitter.on('ping', handler);

      emitter.emit('ping', { n: 1 });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('supports nested emits without disturbing the outer emit', () => {
      const calls: string[] = [];
      emitter.on('ping', () => {
        calls.push('outer-first');
        emitter.emit('pong');
      });
      emitter.on('ping', () => calls.push('outer-second'));
      emitter.on('pong', () => calls.push('inner'));

      emitter.emit('ping', { n: 1 });

      expect(calls).toEqual(['outer-first', 'inner', 'outer-second']);
    });
  });

  describe('clear', () => {
    it('removes all handlers for a single event', () => {
      const pingHandler = vi.fn();
      const pongHandler = vi.fn();
      emitter.on('ping', pingHandler);
      emitter.on('pong', pongHandler);

      emitter.clear('ping');
      emitter.emit('ping', { n: 1 });
      emitter.emit('pong');

      expect(pingHandler).not.toHaveBeenCalled();
      expect(pongHandler).toHaveBeenCalledTimes(1);
    });

    it('removes all handlers for every event when called with no arguments', () => {
      const pingHandler = vi.fn();
      const pongHandler = vi.fn();
      emitter.on('ping', pingHandler);
      emitter.on('pong', pongHandler);

      emitter.clear();
      emitter.emit('ping', { n: 1 });
      emitter.emit('pong');

      expect(pingHandler).not.toHaveBeenCalled();
      expect(pongHandler).not.toHaveBeenCalled();
    });

    it('leaves the emitter usable after clearing', () => {
      emitter.on('ping', vi.fn());
      emitter.clear();

      const handler = vi.fn();
      emitter.on('ping', handler);
      emitter.emit('ping', { n: 1 });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
