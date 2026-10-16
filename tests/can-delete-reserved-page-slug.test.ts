/**
 * A page's slug may not become an address the built site already serves, as
 * a client-origin write. The pass that holds identity keys to their value
 * domain reverts a rename onto `objects` (or removes a page born with it) and
 * leaves an ordinary rename, and a reserved slug a page already holds, alone.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: unknown; env: unknown; constructor(c: unknown, e: unknown) { this.ctx = c; this.env = e; } },
}));

import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";
import { ProjectCollaborationDO } from "../workers/collaboration";

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
  const violations: FakeWS[] = [];
  const halts: Array<{ userId: number; failures: readonly string[] }> = [];
  const counter = makeViolationCounter();

  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => state.snapshotting,
    isReverting: () => state.reverting,
    setReverting: (v: boolean) => { state.reverting = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => {},
    recordViolation: (ws: WebSocket) => { violations.push(ws as unknown as FakeWS); return counter(ws); },
    warn: (msg: string) => { warns.push(msg); },
    onEnforcementFailure: (d) => { halts.push(d); },
  });
  ydoc.on("afterTransaction", handler);

  return { ydoc, warns, violations, halts };
}

/** Seed a Y.Map into a root array with a DO-internal (null) origin. */
function seed(ydoc: Y.Doc, root: string, fields: Record<string, unknown>): Y.Map<unknown> {
  const arr = ydoc.getArray<Y.Map<unknown>>(root);
  let m!: Y.Map<unknown>;
  ydoc.transact(() => {
    m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    arr.push([m]);
  }, null);
  return m;
}

function makeMap(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  return m;
}


describe("a page slug that the site already serves", () => {
  it("reverts a rename onto a reserved address", () => {
    const h = makeHarness();
    const page = seed(h.ydoc, "pages", { _id: 5, slug: "about", created_by: 1 });
    h.ydoc.transact(() => { page.set("slug", "objects"); }, fakeSocket(2, "collaborator"));
    expect(page.get("slug")).toBe("about");
  });

  it("reverts a rename onto a reserved address written with capitals", () => {
    const h = makeHarness();
    const page = seed(h.ydoc, "pages", { _id: 5, slug: "about", created_by: 1 });
    h.ydoc.transact(() => { page.set("slug", "Glossary"); }, fakeSocket(2, "collaborator"));
    expect(page.get("slug")).toBe("about");
  });

  it("removes a page born with a reserved address", () => {
    const h = makeHarness();
    const pages = h.ydoc.getArray<Y.Map<unknown>>("pages");
    h.ydoc.transact(() => {
      pages.push([makeMap({ _id: null, _temp_id: "t-1", slug: "stories", created_by: 2 })]);
    }, fakeSocket(2, "collaborator"));
    expect(pages.length).toBe(0);
  });

  it("lets an ordinary rename stand", () => {
    const h = makeHarness();
    const page = seed(h.ydoc, "pages", { _id: 5, slug: "about", created_by: 1 });
    h.ydoc.transact(() => { page.set("slug", "objects-team"); }, fakeSocket(2, "collaborator"));
    expect(page.get("slug")).toBe("objects-team");
  });

  it("leaves a page that already holds a reserved slug as it is when another field changes", () => {
    const h = makeHarness();
    const page = seed(h.ydoc, "pages", { _id: 5, slug: "objects", created_by: 1 });
    h.ydoc.transact(() => { page.set("created_by", 1); page.set("title", "x"); }, fakeSocket(2, "collaborator"));
    expect(page.get("slug")).toBe("objects");
    expect(h.violations.length).toBe(0);
    expect(h.warns.length).toBe(0);
  });

  it("reverts a change from one reserved address to another", () => {
    const h = makeHarness();
    const page = seed(h.ydoc, "pages", { _id: 5, slug: "objects", created_by: 1 });
    h.ydoc.transact(() => { page.set("slug", "glossary"); }, fakeSocket(2, "collaborator"));
    expect(page.get("slug")).toBe("objects");
  });

  it("reverts a change from a reserved address to a non-string", () => {
    const h = makeHarness();
    const page = seed(h.ydoc, "pages", { _id: 5, slug: "objects", created_by: 1 });
    h.ydoc.transact(() => { page.set("slug", ["about"]); }, fakeSocket(2, "collaborator"));
    expect(page.get("slug")).toBe("objects");
  });
});
