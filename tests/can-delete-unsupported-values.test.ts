/**
 * The persistence halt must be unreachable from a socket.
 *
 * `onEnforcementFailure` stops all persistence for a project. It exists for a
 * throw nobody predicted. A value the mirror knows it cannot rebuild is not
 * that: a client can author one at will, so reaching the halt through it turns
 * a safety mechanism into an availability attack (any socket holder shuts down
 * a project's saving by attaching one shared type and deleting the entity).
 *
 * The rule pinned here: every value a Yjs client can put into a Y.Map either
 * round-trips through the mirror or degrades that one field — logged by path,
 * contained, no halt.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";

type Role = "convenor" | "collaborator" | "instructor";

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: Role };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(userId: number, role: Role): FakeWS {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

function makeHarness() {
  const ydoc = new Y.Doc();
  const state = { reverting: false, snapshotting: false };
  const warns: string[] = [];
  const halts: Array<{ userId: number; failures: readonly string[] }> = [];
  const counter = makeViolationCounter();

  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => state.snapshotting,
    isReverting: () => state.reverting,
    setReverting: (v: boolean) => { state.reverting = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => {},
    recordViolation: (ws: WebSocket) => counter(ws),
    warn: (msg: string) => { warns.push(msg); },
    onEnforcementFailure: (detail) => { halts.push(detail); },
  });
  ydoc.on("afterTransaction", handler);

  return { ydoc, warns, halts };
}

/** Seed an object Y.Map owned by user 1, DO-internal origin. */
function seedStory(ydoc: Y.Doc, fields: Record<string, unknown>): Y.Map<unknown> {
  const arr = ydoc.getArray<Y.Map<unknown>>("stories");
  let m!: Y.Map<unknown>;
  ydoc.transact(() => {
    m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    arr.push([m]);
  }, null);
  return m;
}

/**
 * The probe from the review: attach a shared type the mirror does not model,
 * then delete the entity so the revert has to rebuild it.
 */
function poisonAndDelete(value: () => unknown) {
  const h = makeHarness();
  const story = seedStory(h.ydoc, {
    _id: 10,
    story_id: "victim",
    created_by: 1,
    title: new Y.Text("Victim"),
  });
  const attacker = fakeSocket(2, "collaborator");

  h.ydoc.transact(() => { story.set("poison", value()); }, attacker);
  h.ydoc.transact(() => { h.ydoc.getArray("stories").delete(0, 1); }, attacker);

  return h;
}

describe("a client-authored value the mirror cannot rebuild never halts persistence", () => {
  it("Y.XmlElement — the review's probe", () => {
    const h = poisonAndDelete(() => new Y.XmlElement("div"));

    const stories = h.ydoc.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(1); // containment: the story is restored
    expect(stories.get(0).get("story_id")).toBe("victim");
    expect(h.halts).toEqual([]); // and persistence is NOT halted
  });

  it("Y.XmlFragment", () => {
    const h = poisonAndDelete(() => new Y.XmlFragment());
    expect(h.ydoc.getArray("stories").length).toBe(1);
    expect(h.halts).toEqual([]);
  });

  it("Y.XmlText", () => {
    const h = poisonAndDelete(() => new Y.XmlText("x"));
    expect(h.ydoc.getArray("stories").length).toBe(1);
    expect(h.halts).toEqual([]);
  });

  it("Y.XmlHook", () => {
    const h = poisonAndDelete(() => new Y.XmlHook("widget"));
    expect(h.ydoc.getArray("stories").length).toBe(1);
    expect(h.halts).toEqual([]);
  });

  it("a subdocument", () => {
    const h = poisonAndDelete(() => new Y.Doc());
    expect(h.ydoc.getArray("stories").length).toBe(1);
    expect(h.halts).toEqual([]);
  });

  it("an unsupported value nested one level down, inside a Y.Map value", () => {
    const h = poisonAndDelete(() => {
      const inner = new Y.Map<unknown>();
      inner.set("deep", new Y.XmlElement("span"));
      return inner;
    });
    expect(h.ydoc.getArray("stories").length).toBe(1);
    expect(h.halts).toEqual([]);
  });

  it("an unsupported value nested inside a Y.Array value", () => {
    const h = poisonAndDelete(() => {
      const inner = new Y.Array<unknown>();
      inner.push([new Y.XmlFragment()]);
      return inner;
    });
    expect(h.ydoc.getArray("stories").length).toBe(1);
    expect(h.halts).toEqual([]);
  });

  it("names the dropped field by path in the degraded log", () => {
    const h = poisonAndDelete(() => new Y.XmlElement("div"));
    const degraded = h.warns.filter((w) => w.includes("[canDelete][revert-degraded]"));
    expect(degraded.length).toBe(1);
    expect(degraded[0]).toContain("poison");
  });
});

describe("the field-write path cannot be poisoned into a halt either", () => {
  it("a shared type parked under the course-marker key does not halt the revert", () => {
    // The marker pass compares integer-ness, so parking a Y.Map under the key
    // is not itself a change it sees, and the type stays in the document.
    // Setting a real marker next IS a change, and the revert then has to write
    // that parked type back — re-integrating an already-integrated shared type
    // throws, and the throw lands on the halt.
    const h = makeHarness();
    const story = seedStory(h.ydoc, { _id: 10, story_id: "victim", created_by: 1 });
    const attacker = fakeSocket(2, "collaborator");

    h.ydoc.transact(() => { story.set("course_project_id", new Y.Map()); }, attacker);
    h.ydoc.transact(() => { story.set("course_project_id", 5); }, attacker);

    expect(h.halts).toEqual([]);
    // The forged marker is gone either way — a shared type is not a marker.
    expect(story.get("course_project_id")).toBeUndefined();
  });

  it("the same with a Y.Text parked under the key", () => {
    const h = makeHarness();
    const story = seedStory(h.ydoc, { _id: 10, story_id: "victim", created_by: 1 });
    const attacker = fakeSocket(2, "collaborator");

    h.ydoc.transact(() => { story.set("course_project_id", new Y.Text("x")); }, attacker);
    h.ydoc.transact(() => { story.set("course_project_id", 5); }, attacker);

    expect(h.halts).toEqual([]);
    expect(story.get("course_project_id")).toBeUndefined();
  });
});

describe("a Y.Text carrying an embedded shared type", () => {
  it("does not halt: the embed is dropped and the text survives", () => {
    const h = makeHarness();
    const title = new Y.Text("hola");
    const story = seedStory(h.ydoc, {
      _id: 10,
      story_id: "victim",
      created_by: 1,
      title,
    });
    const attacker = fakeSocket(2, "collaborator");

    h.ydoc.transact(() => { title.insertEmbed(2, new Y.XmlElement("div")); }, attacker);
    h.ydoc.transact(() => { h.ydoc.getArray("stories").delete(0, 1); }, attacker);

    expect(h.halts).toEqual([]);
    const restored = h.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    expect((restored.get("title") as Y.Text).toString()).toBe("hola");
    void story;
  });
});

describe("nesting depth is bounded, so recursion cannot become a halt", () => {
  it("degrades the over-deep field and restores everything above it", () => {
    // Nesting depth is client-chosen and unbounded, and both halves of the
    // mirror recurse. A cap turns the deep tail into one degraded path; with
    // no cap the RangeError lands where the handler reads it as an
    // enforcement failure.
    const h = makeHarness();
    const story = seedStory(h.ydoc, { _id: 10, story_id: "victim", created_by: 1 });
    const attacker = fakeSocket(2, "collaborator");

    // Grown from the integrated tip, one level at a time — the shape a peer
    // can build locally and hand over in a single update.
    h.ydoc.transact(() => {
      story.set("bomb", new Y.Map<unknown>());
      let cur = story.get("bomb") as Y.Map<unknown>;
      for (let i = 0; i < 40; i++) {
        cur.set("level", i);
        cur.set("n", new Y.Map<unknown>());
        cur = cur.get("n") as Y.Map<unknown>;
      }
    }, attacker);
    h.ydoc.transact(() => { h.ydoc.getArray("stories").delete(0, 1); }, attacker);

    expect(h.halts).toEqual([]);
    const stories = h.ydoc.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(1);
    expect(stories.get(0).get("story_id")).toBe("victim");

    let depth = 0;
    let cur = stories.get(0).get("bomb") as Y.Map<unknown> | undefined;
    while (cur instanceof Y.Map && cur.get("n") instanceof Y.Map) {
      cur = cur.get("n") as Y.Map<unknown>;
      depth++;
    }
    expect(depth).toBeGreaterThan(20); // the shallow levels all came back
    expect(depth).toBeLessThan(40); // and the tail past the cap did not
    expect(h.warns.join("\n")).toContain("nested deeper than");
  });
});

describe("the values the mirror does carry still round-trip", () => {
  it("restores Y.Text, Y.Array, Y.Map, binary and plain JSON alongside a dropped field", () => {
    const h = makeHarness();
    const nestedMap = new Y.Map<unknown>();
    nestedMap.set("k", "v");
    const nestedArr = new Y.Array<unknown>();
    nestedArr.push(["a", "b"]);
    const story = seedStory(h.ydoc, {
      _id: 10,
      story_id: "victim",
      created_by: 1,
      title: new Y.Text("Victim"),
      list: nestedArr,
      meta: nestedMap,
      blob: new Uint8Array([1, 2, 3]),
      plain: { a: 1, b: [2, 3] },
      num: 7,
      flag: true,
      nul: null,
    });
    const attacker = fakeSocket(2, "collaborator");
    h.ydoc.transact(() => { story.set("poison", new Y.XmlElement("div")); }, attacker);
    h.ydoc.transact(() => { h.ydoc.getArray("stories").delete(0, 1); }, attacker);

    const restored = h.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    expect(h.halts).toEqual([]);
    expect((restored.get("title") as Y.Text).toString()).toBe("Victim");
    expect((restored.get("list") as Y.Array<unknown>).toArray()).toEqual(["a", "b"]);
    expect((restored.get("meta") as Y.Map<unknown>).get("k")).toBe("v");
    expect(restored.get("blob")).toEqual(new Uint8Array([1, 2, 3]));
    expect(restored.get("plain")).toEqual({ a: 1, b: [2, 3] });
    expect(restored.get("num")).toBe(7);
    expect(restored.get("flag")).toBe(true);
    expect(restored.get("nul")).toBeNull();
    expect(restored.get("poison")).toBeUndefined(); // the one field that is lost
  });
});
