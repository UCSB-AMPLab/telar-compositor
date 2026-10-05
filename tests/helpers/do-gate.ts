/**
 * A `blockConcurrencyWhile` stub that models Cloudflare's gate semantics.
 *
 * The runtime terminates and DISCARDS a Durable Object when an exception
 * escapes a `blockConcurrencyWhile` callback: the in-flight request never
 * receives a response, every WebSocket drops, and in-memory Y.Doc mutations
 * that were not yet flushed are gone. A stub that forwards `fn()` and lets the
 * rejection propagate lets a `catch` placed OUTSIDE the gate turn the throw
 * into a Response — something production can never do. Tests written against
 * such a stub assert behaviour that is unreachable in production.
 *
 * `makeGate` records the termination on the caller's state object.
 * `fetchAsRuntime` then discards whatever the handler returned once a callback
 * has thrown, and rejects instead — which is what the caller observes.
 *
 * The pairing is the point: a route is only durable if it comes back with a
 * Response AND `state.terminated` is still false.
 *
 * @version v1.5.0-beta
 */

export interface GateState {
  /** Set when a gate callback let an exception escape (the DO is discarded). */
  terminated: boolean;
  /** The escaping error, for diagnostics. */
  error: unknown;
}

export function makeGateState(): GateState {
  return { terminated: false, error: undefined };
}

/** The gate stub itself. Pass the same state to `fetchAsRuntime`. */
export function makeGate(state: GateState) {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      state.terminated = true;
      state.error = err;
      throw err;
    }
  };
}

/** Thrown in place of the response the discarded instance never sends. */
export class DurableObjectTerminated extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("Durable Object reset: an exception escaped blockConcurrencyWhile");
    this.name = "DurableObjectTerminated";
    this.cause = cause;
  }
}

/**
 * Drive `doInstance.fetch` the way the runtime does. A Response produced after
 * a gate callback threw is discarded: the instance that produced it has already
 * been thrown away, so nothing is there to send it.
 */
export async function fetchAsRuntime(
  doInstance: { fetch: (request: Request) => Promise<Response> },
  state: GateState,
  request: Request,
): Promise<Response> {
  const res = await doInstance.fetch(request);
  if (state.terminated) throw new DurableObjectTerminated(state.error);
  return res;
}
