// @vitest-environment jsdom
/**
 * The client half of the reset guard. A `/reset` rebuilds the server document
 * from D1, but the editor's `Y.Doc` outlives the socket close and y-websocket
 * carries it straight back in, so the client has to be the one that lets go of
 * it: the reset message replaces both the document and the provider, and the
 * generation the server hands out on every connection is echoed back so the
 * server can refuse a document that predates the rebuild.
 *
 * The pins that matter most here are the ones that must NOT fire. An ordinary
 * connection flap is far more common than a reset and has to leave the document
 * alone.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  CollaborationProvider,
  installSessionControlHandler,
  useCollaborationContext,
} from "~/hooks/use-collaboration";

const MSG_SESSION_CONTROL = 2;
const SUB_PROJECT_DELETED = 0x01;
const SUB_REMOVED_FROM_PROJECT = 0x02;
const SUB_STATE_RESET = 0x03;
const SUB_DOC_GENERATION = 0x04;

/** A server→client session-control frame, exactly as the DO encodes one. */
function controlFrame(subtype: number, value?: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SESSION_CONTROL);
  encoding.writeUint8(enc, subtype);
  if (value !== undefined) encoding.writeVarUint(enc, value);
  return encoding.toUint8Array(enc);
}

/** Feed a frame to an installed handler the way y-websocket's readMessage does. */
function deliver(
  handlers: Array<(...args: never[]) => void>,
  frame: Uint8Array,
): void {
  const decoder = decoding.createDecoder(frame);
  decoding.readVarUint(decoder); // message type, already dispatched on
  const handler = handlers[MSG_SESSION_CONTROL] as unknown as (
    e: unknown, d: unknown, p: unknown, s: unknown, t: unknown,
  ) => void;
  handler(encoding.createEncoder(), decoder, null, false, MSG_SESSION_CONTROL);
}

describe("installSessionControlHandler", () => {
  function install() {
    const calls: Array<[string, number | undefined]> = [];
    const provider = { messageHandlers: [] as Array<(...a: never[]) => void> };
    installSessionControlHandler(provider as never, {
      onProjectDeleted: () => calls.push(["deleted", undefined]),
      onRemovedFromProject: () => calls.push(["removed", undefined]),
      onStateReset: (gen: number | null) => calls.push(["reset", gen ?? undefined]),
      onDocGeneration: (gen: number) => calls.push(["generation", gen]),
    });
    return { calls, handlers: provider.messageHandlers };
  }

  it("routes a state-reset frame, carrying the generation it announces", () => {
    const { calls, handlers } = install();
    deliver(handlers, controlFrame(SUB_STATE_RESET, 3));
    expect(calls).toEqual([["reset", 3]]);
  });

  it("routes a doc-generation frame", () => {
    const { calls, handlers } = install();
    deliver(handlers, controlFrame(SUB_DOC_GENERATION, 7));
    expect(calls).toEqual([["generation", 7]]);
  });

  it("still routes the eviction frames it already handled", () => {
    const { calls, handlers } = install();
    deliver(handlers, controlFrame(SUB_PROJECT_DELETED));
    deliver(handlers, controlFrame(SUB_REMOVED_FROM_PROJECT));
    expect(calls.map((c) => c[0])).toEqual(["deleted", "removed"]);
  });

  it("ignores a subtype it does not know", () => {
    const { calls, handlers } = install();
    deliver(handlers, controlFrame(0x7f));
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CollaborationProvider — what a reset does to the document
// ---------------------------------------------------------------------------

interface FakeProvider {
  awareness: typeof mockAwareness;
  messageHandlers: Array<(...a: never[]) => void>;
  params: Record<string, string>;
  doc: unknown;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  synced: boolean;
}

const mockAwareness = {
  clientID: 1,
  // What the presence expiry reads on each check.
  meta: new Map(),
  states: new Map(),
  getLocalState: vi.fn(() => null),
  setLocalStateField: vi.fn(),
  getStates: vi.fn(() => new Map()),
  on: vi.fn(),
  off: vi.fn(),
};

const providers: FakeProvider[] = [];
const docs: Array<{ destroyed: boolean }> = [];

// The three mocks below stand in for classes the provider calls with `new`,
// so their implementations are function expressions: an arrow function is not
// a constructor, and Vitest 4 constructs the implementation it was given.
vi.mock("y-websocket", () => ({
  WebsocketProvider: vi.fn(
    function (_url: string, _room: string, doc: unknown, opts: { params?: Record<string, string> }) {
      const provider: FakeProvider = {
        awareness: mockAwareness,
        messageHandlers: [],
        params: opts?.params ?? {},
        doc,
        on: vi.fn(),
        off: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        destroy: vi.fn(),
        synced: false,
      };
      providers.push(provider);
      return provider;
    },
  ),
}));

vi.mock("yjs", () => ({
  Doc: vi.fn(function () {
    const doc = {
      destroyed: false,
      getArray: vi.fn(() => []),
      destroy() { doc.destroyed = true; },
    };
    docs.push(doc);
    return doc;
  }),
  UndoManager: vi.fn(function () {
    return { on: vi.fn(), off: vi.fn(), destroy: vi.fn(), undoStack: [], redoStack: [] };
  }),
}));

let capturedDoc: unknown;

function DocConsumer() {
  capturedDoc = useCollaborationContext().ydoc;
  return null;
}

function renderProvider() {
  return render(
    <CollaborationProvider projectId={1} userGithubId={42} userName="alice" presenceColor="#abc">
      <DocConsumer />
    </CollaborationProvider>,
  );
}

beforeEach(() => {
  providers.length = 0;
  docs.length = 0;
  capturedDoc = undefined;
  vi.clearAllMocks();
});

describe("CollaborationProvider and the reset guard", () => {
  it("echoes the announced generation back on the connection query string", () => {
    renderProvider();
    const provider = providers[0];
    act(() => { deliver(provider.messageHandlers, controlFrame(SUB_DOC_GENERATION, 4)); });
    // y-websocket reads `params` afresh on every reconnection, so writing into
    // the object the provider already holds is what reaches the next socket.
    expect(provider.params.gen).toBe("4");
  });

  it("replaces the document and the provider when the server announces a reset", () => {
    renderProvider();
    const firstProvider = providers[0];
    const firstDoc = docs[0];
    expect(capturedDoc).toBe(firstDoc);

    act(() => { deliver(firstProvider.messageHandlers, controlFrame(SUB_STATE_RESET, 1)); });

    // The pre-reset document is gone, not merely disconnected: keeping it would
    // put its whole contents back into the rebuilt server document on the next
    // sync exchange.
    expect(firstDoc.destroyed).toBe(true);
    expect(firstProvider.destroy).toHaveBeenCalled();
    expect(providers).toHaveLength(2);
    expect(docs).toHaveLength(2);
    expect(capturedDoc).toBe(docs[1]);
    expect(docs[1].destroyed).toBe(false);
  });

  it("stops the old provider reconnecting before the replacement is built", () => {
    renderProvider();
    const firstProvider = providers[0];
    act(() => { deliver(firstProvider.messageHandlers, controlFrame(SUB_STATE_RESET, 1)); });
    // y-websocket schedules its own reconnection the moment the socket closes,
    // and that reconnection would carry the pre-reset document.
    expect(firstProvider.disconnect).toHaveBeenCalled();
  });

  it("states that its first connection carries a document it has just built", () => {
    renderProvider();
    // The server cannot tell a document built a moment ago from one that
    // predates a reset unless the client says which it is, and a client that
    // says nothing is refused. This claim is what admits a first connection,
    // a fresh tab, and the rebuild below.
    expect(providers[0].params.gen).toBe("new");
  });

  it("presents a freshly built document on the replacement connection", () => {
    renderProvider();
    act(() => { deliver(providers[0].messageHandlers, controlFrame(SUB_DOC_GENERATION, 1)); });
    act(() => { deliver(providers[0].messageHandlers, controlFrame(SUB_STATE_RESET, 2)); });
    // The replacement document belongs to no generation until the server names
    // one; claiming the old one would have the server refuse it on sight.
    expect(providers[1].params.gen).toBe("new");
  });

  it("leaves the document alone through an ordinary connection flap", () => {
    renderProvider();
    const firstDoc = docs[0];
    const statusHandler = providers[0].on.mock.calls.find((c) => c[0] === "status")?.[1] as
      | ((e: { status: string }) => void)
      | undefined;
    expect(statusHandler).toBeDefined();

    act(() => { statusHandler!({ status: "disconnected" }); });
    act(() => { statusHandler!({ status: "connecting" }); });
    act(() => { statusHandler!({ status: "connected" }); });

    expect(firstDoc.destroyed).toBe(false);
    expect(providers).toHaveLength(1);
    expect(docs).toHaveLength(1);
    expect(capturedDoc).toBe(firstDoc);
  });

  it("leaves the document alone when the server re-announces the same generation", () => {
    renderProvider();
    const firstDoc = docs[0];
    act(() => { deliver(providers[0].messageHandlers, controlFrame(SUB_DOC_GENERATION, 2)); });
    act(() => { deliver(providers[0].messageHandlers, controlFrame(SUB_DOC_GENERATION, 2)); });
    expect(firstDoc.destroyed).toBe(false);
    expect(docs).toHaveLength(1);
  });
});
