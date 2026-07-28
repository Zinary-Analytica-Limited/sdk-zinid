/**
 * Typed event emitter — the single notification path for the whole SDK.
 *
 * Every event a vendor can observe funnels through one instance of this class,
 * so options-object handlers (`onComplete`) and `.on('complete')` are just two
 * subscriptions on the same emitter and can never shadow each other.
 *
 * Pure logic: no DOM, no window, no dependencies. Safe to import during a
 * server render.
 */

/**
 * Shape of an event map: event name to payload type. Use `void` for no payload.
 *
 * The emitter constrains its map to `object` rather than to this alias, so that
 * event maps declared as `interface` are accepted too — an interface has no
 * implicit index signature and would fail a `Record<string, unknown>` bound.
 */
export type EventMap = Record<string, unknown>;

/** Handler for a payload of type `T`. */
export type EventHandler<T> = (payload: T) => void;

/**
 * Emit arguments for a payload: no argument when the payload is `void`,
 * exactly one otherwise.
 */
export type EmitArgs<T> = [T] extends [void] ? [] : [payload: T];

/**
 * Handlers of differing payload types share one collection. `never` in the
 * parameter position makes every concrete handler assignable here (parameters
 * are contravariant), and the payload type is restored at call time.
 */
type StoredHandler = EventHandler<never>;

export class Emitter<M extends object> {
  // `private` rather than `#private` — erased at compile time, so it costs
  // nothing in the bundle, where `#` would downlevel to a WeakMap for es2020.
  private readonly handlers = new Map<keyof M, Set<StoredHandler>>();

  /**
   * Subscribe to an event. Registering the same function twice is a no-op, so a
   * single `off` call always fully unsubscribes it.
   */
  on<K extends keyof M>(event: K, handler: EventHandler<M[K]>): void {
    let registered = this.handlers.get(event);
    if (!registered) {
      registered = new Set();
      this.handlers.set(event, registered);
    }
    registered.add(handler as StoredHandler);
  }

  /** Unsubscribe a specific handler. Unknown events and handlers are ignored. */
  off<K extends keyof M>(event: K, handler: EventHandler<M[K]>): void {
    const registered = this.handlers.get(event);
    if (!registered) return;
    registered.delete(handler as StoredHandler);
    if (registered.size === 0) this.handlers.delete(event);
  }

  /**
   * Notify every handler registered for an event, in registration order.
   *
   * Mutation during an in-flight emit is well defined: iteration runs over a
   * snapshot, so handlers added mid-emit wait for the next one, while each
   * handler is re-checked against the live set, so one removed mid-emit does
   * not run at all. Either way the untouched handlers fire exactly once.
   *
   * A throwing handler never interrupts the others. Its error is re-thrown on a
   * fresh task, surfacing to the global error handler with its stack intact
   * rather than being swallowed.
   */
  emit<K extends keyof M>(event: K, ...args: EmitArgs<M[K]>): void {
    const registered = this.handlers.get(event);
    if (!registered) return;

    const payload = args[0] as M[K];
    for (const handler of [...registered]) {
      if (!registered.has(handler)) continue;
      try {
        (handler as EventHandler<M[K]>)(payload);
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  /** Remove all handlers for one event, or for every event when called bare. */
  clear(event?: keyof M): void {
    if (event === undefined) {
      this.handlers.clear();
    } else {
      this.handlers.delete(event);
    }
  }
}
