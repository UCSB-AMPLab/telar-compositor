// @vitest-environment jsdom
/**
 * Pins `usePersistenceHalt` — the client trigger that asks whether a stubborn
 * disconnection is a halt, and the restore it submits.
 *
 * The provider here emits the real event sequence a refused upgrade produces:
 * `connection-close` for a socket the server closed with no body, `connecting`
 * on every backoff retry, `disconnected` only once a connection has existed, and
 * `connected` at `onopen` — which is not admission, and which is why the
 * generation handshake, counted as `admissionEpoch`, is the one thing that
 * clears a halt.
 *
 * Timings are exact because the jitter is stubbed to zero; the fetch is counted
 * and scripted so that "one read in flight" and "this response is obsolete" are
 * assertions about behaviour rather than about how long anything took.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

/** A provider-shaped emitter with the two events the trigger listens for. */
function makeProvider(label: string) {
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  return {
    label,
    on(event: string, fn: (...args: never[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: never[]) => void) {
      handlers.get(event)?.delete(fn);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(handlers.get(event) ?? [])]) {
        (fn as (...a: unknown[]) => void)(...args);
      }
    },
    listenerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

type Provider = ReturnType<typeof makeProvider>;

const collaboration: { provider: Provider | null; admissionEpoch: number } = {
  provider: null,
  admissionEpoch: 0,
};

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => collaboration,
}));

import {
  persistenceReadJitter,
  usePersistenceHalt,
} from "~/hooks/use-persistence-halt";

const PROJECT_ID = 7;

/** A JSON answer the trigger can apply. */
function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

const HALTED = { projectId: PROJECT_ID, halted: true, reason: "apply_failed", at: 11, generation: 4 };
const HEALTHY = { projectId: PROJECT_ID, halted: false, generation: 5 };

/** What the action route answers: the outcome and the readback beside it. */
function actionAnswer(reset: unknown, state: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ projectId: PROJECT_ID, reset, state }),
    text: async () => "",
  };
}

/** A promise the test resolves when it chooses, so a read can be held open. */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Reads only — the action POSTs to the same path with a body. */
function reads(): string[] {
  return fetchMock.mock.calls.filter((call) => call[1] === undefined).map((c) => String(c[0]));
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount() {
  return renderHook(() => usePersistenceHalt(PROJECT_ID));
}

beforeEach(() => {
  vi.useFakeTimers();
  persistenceReadJitter.next = () => 0;
  collaboration.provider = makeProvider("first");
  collaboration.admissionEpoch = 0;
  fetchMock = vi.fn(async () => okJson(HEALTHY));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The disconnection clock
// ---------------------------------------------------------------------------

describe("the clock measures a continuous disconnection", () => {
  it("reads nothing while the connection has never closed", async () => {
    mount();
    await tick(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires the first read five seconds after the first close", async () => {
    mount();
    act(() => collaboration.provider!.emit("connection-close"));

    await tick(4_999);
    expect(fetchMock).not.toHaveBeenCalled();

    await tick(1);
    expect(reads()).toEqual([`/api/persistence?projectId=${PROJECT_ID}`]);
  });

  it("is not restarted by the connecting events every backoff retry fires", async () => {
    mount();
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(3_000);
    act(() => {
      collaboration.provider!.emit("status", { status: "connecting" });
      collaboration.provider!.emit("connection-close");
      collaboration.provider!.emit("status", { status: "connecting" });
    });

    // Five seconds from the FIRST close, not from the retries in between.
    await tick(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("also starts on a disconnected status, which follows a real connection", async () => {
    mount();
    act(() => collaboration.provider!.emit("status", { status: "disconnected" }));
    await tick(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires the second read at thirty-five seconds with the jitter stubbed to zero", async () => {
    mount();
    act(() => collaboration.provider!.emit("connection-close"));

    await tick(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps one read in flight at a time", async () => {
    const held = deferred<ReturnType<typeof okJson>>();
    fetchMock.mockImplementationOnce(() => held.promise);
    mount();
    act(() => collaboration.provider!.emit("connection-close"));

    await tick(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The interval keeps arming while the first read is still open, and skips.
    await tick(70_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      held.settle(okJson(HEALTHY));
      await held.promise;
    });
    await tick(35_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches nothing further after teardown", async () => {
    const { unmount } = mount();
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await tick(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes both listeners on teardown", () => {
    const { unmount } = mount();
    const provider = collaboration.provider!;
    expect(provider.listenerCount("connection-close")).toBe(1);
    expect(provider.listenerCount("status")).toBe(1);
    unmount();
    expect(provider.listenerCount("connection-close")).toBe(0);
    expect(provider.listenerCount("status")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What each answer does
// ---------------------------------------------------------------------------

describe("what a read does with each answer", () => {
  async function readOnce(answer: unknown) {
    const view = mount();
    if (answer instanceof Error) fetchMock.mockRejectedValue(answer);
    else fetchMock.mockResolvedValue(answer as ReturnType<typeof okJson>);
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    return view;
  }

  it("sets the halt and stops reading on halted true", async () => {
    const { result } = await readOnce(okJson(HALTED));

    expect(result.current.halted).toBe(true);
    expect(result.current.lastKnownHalt).toEqual({
      projectId: PROJECT_ID,
      reason: "apply_failed",
      at: 11,
      generation: 4,
    });
    expect(result.current.stateUnreadable).toBe(false);
    expect(result.current.confirmedGeneration).toBe(4);

    await tick(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a known halt set on halted false, and records the confirmed generation", async () => {
    const { result } = await readOnce(okJson(HALTED));
    expect(result.current.halted).toBe(true);

    fetchMock.mockResolvedValue(okJson(HEALTHY));
    await act(async () => result.current.checkAgain());
    await settle();

    // `halted: false` says there is no marker for the current generation, not
    // that the document can load — a reset that advanced the generation and
    // failed its rebuild leaves exactly that.
    expect(result.current.halted).toBe(true);
    expect(result.current.stateUnreadable).toBe(false);
    expect(result.current.confirmedGeneration).toBe(5);
  });

  it("leaves a known halt set on a failed read, and marks the state unreadable", async () => {
    const { result } = await readOnce(okJson(HALTED));

    fetchMock.mockRejectedValue(new Error("offline"));
    await act(async () => result.current.checkAgain());
    await settle();

    expect(result.current.halted).toBe(true);
    expect(result.current.stateUnreadable).toBe(true);
    expect(result.current.confirmedGeneration).toBeNull();
  });

  it("treats an unavailable object as unreadable rather than as not halted", async () => {
    const { result } = await readOnce(okJson({ projectId: PROJECT_ID, halted: null, unavailable: "storage_unavailable" }));

    expect(result.current.halted).toBe(false);
    expect(result.current.stateUnreadable).toBe(true);
    expect(result.current.confirmedGeneration).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What clears the halt
// ---------------------------------------------------------------------------

describe("only the generation handshake clears a halt", () => {
  async function halted() {
    const view = mount();
    fetchMock.mockResolvedValue(okJson(HALTED));
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    expect(view.result.current.halted).toBe(true);
    return view;
  }

  it("clears nothing on a connected status", async () => {
    const { result } = await halted();
    await act(async () => {
      collaboration.provider!.emit("status", { status: "connected" });
    });
    expect(result.current.halted).toBe(true);
  });

  it("clears the halt and stops the clock on an admission", async () => {
    const { result, rerender } = await halted();

    collaboration.admissionEpoch = 1;
    await act(async () => rerender());

    expect(result.current.halted).toBe(false);
    expect(result.current.lastKnownHalt).toBeNull();
    await tick(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards the state read before it, so nothing pre-reset can be shown as fresh", async () => {
    const { result, rerender } = await halted();
    expect(result.current.lastReadHalted).toBe(true);

    collaboration.admissionEpoch = 1;
    await act(async () => rerender());

    // The halt, and the read that reported it, both belong to the generation
    // the admission proves is being served.
    expect(result.current.lastReadHalted).toBeNull();
    expect(result.current.stateUnreadable).toBe(false);
    expect(result.current.haltedAgain).toBe(false);
    // The generation the object confirmed is a fact, and the convenor may need
    // it if the connection drops again.
    expect(result.current.confirmedGeneration).toBe(4);
  });

  it("arms the clock again for a disconnection after an admission", async () => {
    const { rerender } = await halted();
    collaboration.admissionEpoch = 1;
    await act(async () => rerender());

    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The ordering policy
// ---------------------------------------------------------------------------

describe("a response is applied only while it is still about the same thing", () => {
  /** Start a read and hand back the gate that finishes it. */
  async function heldRead() {
    const held = deferred<ReturnType<typeof okJson>>();
    fetchMock.mockImplementationOnce(() => held.promise);
    const view = mount();
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    return { ...view, held };
  }

  it("drops an answer whose request preceded an admission", async () => {
    const { result, rerender, held } = await heldRead();

    collaboration.admissionEpoch = 1;
    await act(async () => rerender());

    await act(async () => {
      held.settle(okJson(HALTED));
      await held.promise;
    });
    await settle();

    // A delayed `halted: true` must not reinstall a halt admission cleared.
    expect(result.current.halted).toBe(false);
    expect(result.current.lastKnownHalt).toBeNull();
  });

  it("drops an answer whose provider has been replaced", async () => {
    const { result, rerender, held } = await heldRead();

    collaboration.provider = makeProvider("second");
    await act(async () => rerender());

    await act(async () => {
      held.settle(okJson(HALTED));
      await held.promise;
    });
    await settle();

    expect(result.current.halted).toBe(false);
  });

  it("drops an answer whose project has been switched", async () => {
    const held = deferred<ReturnType<typeof okJson>>();
    fetchMock.mockImplementationOnce(() => held.promise);
    let projectId = PROJECT_ID;
    const { result, rerender } = renderHook(() => usePersistenceHalt(projectId));
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);

    projectId = 99;
    await act(async () => rerender());
    await act(async () => {
      held.settle(okJson(HALTED));
      await held.promise;
    });
    await settle();

    expect(result.current.halted).toBe(false);
  });

  it("drops a read older than the readback the action already applied", async () => {
    // A popover read captured at generation 4 completes after a reset whose
    // readback confirmed 5; applying it would put the older number back on the
    // confirm the convenor is about to press.
    fetchMock.mockResolvedValue(okJson(HALTED));
    const { result } = mount();
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    expect(result.current.confirmedGeneration).toBe(4);

    const slowRead = deferred<ReturnType<typeof okJson>>();
    fetchMock.mockImplementationOnce(() => slowRead.promise);
    act(() => result.current.checkAgain());

    fetchMock.mockResolvedValue(
      actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }),
    );
    await act(async () => result.current.restore(4));
    await settle();
    expect(result.current.confirmedGeneration).toBe(5);

    await act(async () => {
      slowRead.settle(okJson({ projectId: PROJECT_ID, halted: false, generation: 4 }));
      await slowRead.promise;
    });
    await settle();

    expect(result.current.confirmedGeneration).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

describe("the restore, its readback and its outcome", () => {
  async function haltedView() {
    const view = mount();
    fetchMock.mockResolvedValue(okJson(HALTED));
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    return view;
  }

  it("posts the intent, the project and the generation", async () => {
    const { result } = await haltedView();
    fetchMock.mockResolvedValue(actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }));

    await act(async () => result.current.restore(4));
    await settle();

    const [url, init] = fetchMock.mock.calls[1] as [string, { method: string; body: FormData }];
    expect(url).toBe("/api/persistence");
    expect(init.method).toBe("POST");
    expect(init.body.get("intent")).toBe("reset");
    expect(init.body.get("projectId")).toBe(String(PROJECT_ID));
    expect(init.body.get("expectedGeneration")).toBe("4");
    expect(result.current.outcome).toEqual({ kind: "landed" });
    expect(result.current.lastReadHalted).toBe(false);
    expect(result.current.confirmedGeneration).toBe(5);
  });

  it("issues no further read after the readback", async () => {
    const { result } = await haltedView();
    fetchMock.mockResolvedValue(actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }));

    await act(async () => result.current.restore(4));
    await settle();

    // The readback IS the post-action refresh: one read, one action, no third.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an unreadable readback without touching the outcome", async () => {
    const { result } = await haltedView();
    fetchMock.mockResolvedValue(actionAnswer({ kind: "landed" }, { unreadable: true }));

    await act(async () => result.current.restore(4));
    await settle();

    expect(result.current.outcome).toEqual({ kind: "landed" });
    expect(result.current.stateUnreadable).toBe(true);
    expect(result.current.confirmedGeneration).toBeNull();
  });

  it("keeps the outcome when a provider replacement obsoletes the snapshot", async () => {
    const { result, rerender } = await haltedView();
    const held = deferred<ReturnType<typeof actionAnswer>>();
    fetchMock.mockImplementationOnce(() => held.promise);

    await act(async () => result.current.restore(4));
    collaboration.provider = makeProvider("second");
    await act(async () => rerender());

    await act(async () => {
      held.settle(actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }));
      await held.promise;
    });
    await settle();

    expect(result.current.outcome).toEqual({ kind: "landed" });
    // The snapshot the readback carried belongs to a provider that is gone.
    expect(result.current.confirmedGeneration).toBe(4);
  });

  it("keeps the outcome when an admission arrives before the response", async () => {
    const { result, rerender } = await haltedView();
    const held = deferred<ReturnType<typeof actionAnswer>>();
    fetchMock.mockImplementationOnce(() => held.promise);

    await act(async () => result.current.restore(4));
    collaboration.admissionEpoch = 1;
    await act(async () => rerender());

    await act(async () => {
      held.settle(actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }));
      await held.promise;
    });
    await settle();

    expect(result.current.outcome).toEqual({ kind: "landed" });
    expect(result.current.halted).toBe(false);
  });

  it("runs a Check again pressed during the action once, after the readback", async () => {
    const { result } = await haltedView();
    const held = deferred<ReturnType<typeof actionAnswer>>();
    fetchMock.mockImplementationOnce(() => held.promise);

    await act(async () => result.current.restore(4));
    act(() => {
      result.current.checkAgain();
      result.current.checkAgain();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue(okJson({ projectId: PROJECT_ID, halted: false, generation: 6 }));
    await act(async () => {
      held.settle(actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }));
      await held.promise;
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.confirmedGeneration).toBe(6);
  });

  it("holds the submitting flag for the length of the action", async () => {
    const { result } = await haltedView();
    const held = deferred<ReturnType<typeof actionAnswer>>();
    fetchMock.mockImplementationOnce(() => held.promise);

    await act(async () => result.current.restore(4));
    expect(result.current.submitting).toBe(true);

    await act(async () => {
      held.settle(actionAnswer({ kind: "retry" }, { unreadable: true }));
      await held.promise;
    });
    await settle();
    expect(result.current.submitting).toBe(false);
    expect(result.current.outcome).toEqual({ kind: "retry" });
  });

  it("sends one reset per click, never two at once", async () => {
    const { result } = await haltedView();
    const held = deferred<ReturnType<typeof actionAnswer>>();
    fetchMock.mockImplementationOnce(() => held.promise);

    await act(async () => {
      result.current.restore(4);
      result.current.restore(4);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      held.settle(actionAnswer({ kind: "landed" }, { unreadable: true }));
      await held.promise;
    });
    await settle();
  });

  it("calls the project halted again only for a read above the generation it confirmed", async () => {
    const { result } = await haltedView();
    fetchMock.mockResolvedValue(
      actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: true, reason: "log_corrupt", at: 12, generation: 5 }),
    );

    await act(async () => result.current.restore(4));
    await settle();

    expect(result.current.outcome).toEqual({ kind: "landed" });
    expect(result.current.haltedAgain).toBe(true);
  });

  it("does not call it halted again when the read names the generation the restore replaced", async () => {
    // The same number the confirm carried is the state the restore was meant
    // to clear, not a halt the rebuild raised.
    const { result } = await haltedView();
    fetchMock.mockResolvedValue(
      actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: true, reason: "log_corrupt", at: 12, generation: 4 }),
    );

    await act(async () => result.current.restore(4));
    await settle();

    expect(result.current.haltedAgain).toBe(false);
  });

  it("reports a non-ok action response as a failure and a throw as uncertain", async () => {
    const { result } = await haltedView();

    fetchMock.mockResolvedValue({ ok: false, status: 409, text: async () => "project_mismatch" });
    await act(async () => result.current.restore(4));
    await settle();
    expect(result.current.outcome).toEqual({
      kind: "failed",
      status: 409,
      body: "project_mismatch",
    });

    fetchMock.mockRejectedValue(new Error("offline"));
    await act(async () => result.current.restore(4));
    await settle();
    expect(result.current.outcome).toEqual({ kind: "uncertain" });
  });
});


// ---------------------------------------------------------------------------
// One scheduler for every read
// ---------------------------------------------------------------------------

describe("every read is admitted by one scheduler", () => {
  async function haltedWithHeldRead() {
    const view = mount();
    fetchMock.mockResolvedValue(okJson(HALTED));
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    expect(view.result.current.halted).toBe(true);

    const held = deferred<ReturnType<typeof okJson>>();
    fetchMock.mockImplementationOnce(() => held.promise);
    act(() => view.result.current.checkAgain());
    expect(reads()).toHaveLength(2);
    return { ...view, held };
  }

  it("coalesces a request made while a read is in flight into a single further GET", async () => {
    const { result, held } = await haltedWithHeldRead();

    act(() => {
      result.current.checkAgain();
      result.current.checkAgain();
    });
    // Neither reached the network: one read is in flight, and the queue holds
    // at most one request however many times it is asked for.
    expect(reads()).toHaveLength(2);

    fetchMock.mockResolvedValue(okJson(HEALTHY));
    await act(async () => {
      held.settle(okJson(HALTED));
      await held.promise;
    });
    await settle();

    expect(reads()).toHaveLength(3);
  });

  it("queues the action's completion behind a read that is still in flight", async () => {
    const { result, held } = await haltedWithHeldRead();

    act(() => result.current.checkAgain());
    const action = deferred<ReturnType<typeof actionAnswer>>();
    fetchMock.mockImplementationOnce(() => action.promise);
    await act(async () => result.current.restore(4));
    expect(reads()).toHaveLength(2);

    await act(async () => {
      action.settle(actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }));
      await action.promise;
    });
    await settle();
    // The queued check cannot run while the older GET is still open.
    expect(reads()).toHaveLength(2);

    fetchMock.mockResolvedValue(okJson(HEALTHY));
    await act(async () => {
      held.settle(okJson(HALTED));
      await held.promise;
    });
    await settle();

    expect(reads()).toHaveLength(3);
  });

  it("reads nothing after teardown for a check queued during the action", async () => {
    const view = mount();
    fetchMock.mockResolvedValue(okJson(HALTED));
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);

    const action = deferred<ReturnType<typeof actionAnswer>>();
    fetchMock.mockImplementationOnce(() => action.promise);
    await act(async () => view.result.current.restore(4));
    act(() => view.result.current.checkAgain());

    view.unmount();
    await act(async () => {
      action.settle(actionAnswer({ kind: "landed" }, { unreadable: true }));
      await action.promise;
    });
    await settle();
    await tick(300_000);

    // One read, one POST, and nothing after the teardown.
    expect(reads()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The confirmation belongs to the project it was read for
// ---------------------------------------------------------------------------

describe("a confirmation is never applied to another project", () => {
  /** A halt held for PROJECT_ID, with the tab's project id under the test's control. */
  async function haltedThenSwitched() {
    let projectId = PROJECT_ID;
    fetchMock.mockResolvedValue(okJson(HALTED));
    const view = renderHook(() => usePersistenceHalt(projectId));
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);
    expect(view.result.current.lastKnownHalt).toMatchObject({ projectId: PROJECT_ID });
    expect(view.result.current.confirmedGeneration).toBe(4);

    projectId = 99;
    await act(async () => view.rerender());
    return view;
  }

  it("empties the state the moment the tab selects another project", async () => {
    const { result } = await haltedThenSwitched();

    expect(result.current.halted).toBe(false);
    expect(result.current.lastKnownHalt).toBeNull();
    expect(result.current.confirmedGeneration).toBeNull();
    expect(result.current.lastReadHalted).toBeNull();
    expect(result.current.stateUnreadable).toBe(false);
    expect(result.current.outcome).toBeNull();
    expect(result.current.submitting).toBe(false);
  });

  it("sends no reset for the project the tab has switched to", async () => {
    const { result } = await haltedThenSwitched();
    const before = fetchMock.mock.calls.length;

    await act(async () => result.current.restore(4));
    await settle();

    // Project 99 may well be at generation 4 and owned by this user, in which
    // case the server would accept the request — and it is not the one shown.
    expect(fetchMock).toHaveBeenCalledTimes(before);
    expect(result.current.outcome).toBeNull();
  });

  it("keeps the confirmation for the project it was read for while that project is selected", async () => {
    fetchMock.mockResolvedValue(okJson(HALTED));
    const { result } = mount();
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);

    fetchMock.mockResolvedValue(
      actionAnswer({ kind: "landed" }, { projectId: PROJECT_ID, halted: false, generation: 5 }),
    );
    await act(async () => result.current.restore(4));
    await settle();

    const [, init] = fetchMock.mock.calls[1] as [string, { body: FormData }];
    expect(init.body.get("projectId")).toBe(String(PROJECT_ID));
  });
});

// ---------------------------------------------------------------------------
// Dismissing the outcome
// ---------------------------------------------------------------------------

describe("the outcome is dismissed once its reader has done with it", () => {
  it("clears the outcome and leaves the rest of the state alone", async () => {
    fetchMock.mockResolvedValue(okJson(HALTED));
    const { result } = mount();
    act(() => collaboration.provider!.emit("connection-close"));
    await tick(5_000);

    fetchMock.mockResolvedValue(actionAnswer({ kind: "retry" }, HALTED));
    await act(async () => result.current.restore(4));
    await settle();
    expect(result.current.outcome).toEqual({ kind: "retry" });

    act(() => result.current.dismissOutcome());

    expect(result.current.outcome).toBeNull();
    // The halt is not the outcome: it stands until admission clears it.
    expect(result.current.halted).toBe(true);
    expect(result.current.confirmedGeneration).toBe(4);
  });
});
