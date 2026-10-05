/**
 * One object's failure in the objects extra-columns repair is that object's alone
 *
 * The repair runs on every load, inside a try/catch in `documentRepairs` that
 * keeps a throw from failing the load. That catch's SCOPE is what this suite is
 * about: wrapped around the whole pass, one object nobody can repair turns the
 * repair off for every object in the project, on that load and on every load
 * after it, and the only thing said about it is a log line. The stale column it
 * exists to remove then stands in the blob, and publish writes it beside the
 * field's own.
 *
 * The throw is INJECTED, and it has to be. `readObjectFieldAsString` renders
 * through `proseString`, which converts no embed, and every value
 * `promoteModelledExtras` returns for a field has been through
 * `blobValueAsString`, so it is a string and `replaceYText`'s precondition
 * holds. No value a document can carry reaches a throw in either half of the
 * pass. What is under test is the containment, and a containment is about where
 * a throw stops, not about what raised it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// The repair's decision for one object, made to throw for a chosen blob. Every
// other object goes through the real implementation, so what the suite watches
// is the pass carrying on rather than a stub standing in for it.
const failFor = { header: null as string | null };
vi.mock("~/lib/extra-columns.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/extra-columns.server")>();
  return {
    ...actual,
    promoteModelledExtras: (extras: Record<string, unknown>, current: Record<string, string>) => {
      if (failFor.header !== null && failFor.header in extras) {
        throw new Error("planted");
      }
      return actual.promoteModelledExtras(extras, current);
    },
  };
});

import { ProjectCollaborationDO } from "../workers/collaboration";

/** A DO instance with a document but no sockets, storage or D1 traffic. */
function makeDO() {
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (cb: () => Promise<void>) => cb(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const instance = new ProjectCollaborationDO(ctx as never, {} as never);
  (instance as unknown as { projectId: number }).projectId = 42;
  return {
    instance,
    ydoc: (instance as unknown as { ydoc: Y.Doc }).ydoc,
    repair: () =>
      (instance as unknown as { promoteModelledObjectExtras: () => void })
        .promoteModelledObjectExtras(),
  };
}

/** One object with a stale blob naming `header` as the source of its type. */
function addObject(ydoc: Y.Doc, id: number, header: string, value: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  ydoc.getArray<Y.Map<unknown>>("objects").push([map]);
  ydoc.transact(() => {
    map.set("_id", id);
    map.set("object_type", new Y.Text(""));
    map.set("extra_columns", JSON.stringify({ [header]: value }));
  });
  return map;
}

function repaired(map: Y.Map<unknown>): { type: string; extras: unknown } {
  return {
    type: (map.get("object_type") as Y.Text).toString(),
    extras: map.get("extra_columns"),
  };
}

describe("the extras repair contains one object's failure", () => {
  it("repairs every other object in the same pass", () => {
    const { ydoc, repair } = makeDO();
    const first = addObject(ydoc, 1, "medium", "óleo");
    const broken = addObject(ydoc, 2, "tecnica", "acuarela");
    const last = addObject(ydoc, 3, "medium", "grabado");
    failFor.header = "tecnica";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => repair()).not.toThrow();

      // The object before the failure and the object after it were both
      // repaired: the pass neither stopped at the throw nor skipped the ones
      // it had already decided.
      expect(repaired(first)).toEqual({ type: "óleo", extras: "" });
      expect(repaired(last)).toEqual({ type: "grabado", extras: "" });
      // The one that threw kept its blob and its empty field, which is the
      // state it was already in.
      expect(repaired(broken)).toEqual({ type: "", extras: JSON.stringify({ tecnica: "acuarela" }) });
    } finally {
      failFor.header = null;
      logged.mockRestore();
    }
  });

  it("names the object it could not repair, and how many of how many", () => {
    const { ydoc, repair } = makeDO();
    addObject(ydoc, 1, "medium", "óleo");
    addObject(ydoc, 2, "tecnica", "acuarela");
    failFor.header = "tecnica";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      repair();
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0][0]);
      expect(line).toContain("arm=extras-repair root=objects");
      expect(line).toContain("1 of 2 objects kept their extra_columns");
      expect(line).toContain("object 2");
      // The row id and the error, and nothing the client wrote: a log line
      // built from a planted value hands it back to whoever planted it.
      expect(line).not.toContain("acuarela");
    } finally {
      failFor.header = null;
      logged.mockRestore();
    }
  });

  it("says nothing on a pass where every object was repaired", () => {
    const { ydoc, repair } = makeDO();
    addObject(ydoc, 1, "medium", "óleo");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      repair();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("reports the whole pass when what fails is not one object", () => {
    // `documentRepairs` is the outer catch, and what reaches it is whatever
    // yjs raises around the pass rather than inside one object. It is reported
    // as the project's repair because that is what it costs.
    const { instance } = makeDO();
    const target = instance as unknown as {
      promoteModelledObjectExtras: () => void;
      documentRepairs: () => void;
    };
    target.promoteModelledObjectExtras = () => { throw new Error("planted"); };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => target.documentRepairs()).not.toThrow();
      const line = String(logged.mock.calls[0][0]);
      expect(line).toContain("the repair did not run and every object kept its extra_columns");
      expect(line).toContain("Error: planted");
    } finally {
      logged.mockRestore();
    }
  });
});
