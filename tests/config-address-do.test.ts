/**
 * A client-origin write of `url` or `baseurl` is held to the rules the Site
 * settings field applies, at the Durable Object's document. An address the
 * rules refuse is put back to the value it replaced, a valid one stands, and a
 * value equal to the stored one stands even when the rules would refuse it, so
 * a site whose address predates them keeps it. Server-origin writes are not
 * judged.
 *
 * @version v1.5.5-beta
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
  return { deserializeAttachment: () => ({ userId, role }), send: vi.fn(), close: vi.fn() };
}

function makeHarness(stored: Record<string, unknown>) {
  const ydoc = new Y.Doc();
  const state = { reverting: false };
  const warns: string[] = [];
  const counter = makeViolationCounter();
  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => false,
    isReverting: () => state.reverting,
    setReverting: (v: boolean) => { state.reverting = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => {},
    recordViolation: (ws: WebSocket) => counter(ws),
    warn: (msg: string) => { warns.push(msg); },
  });
  ydoc.on("afterTransaction", handler);
  const config = ydoc.getMap<unknown>("config");
  ydoc.transact(() => {
    for (const [k, v] of Object.entries(stored)) config.set(k, v);
  }, null);
  return { ydoc, config, warns };
}

const STORED = { url: "https://real.example.org", baseurl: "/sitio", title: "Sitio" };
const convenor = () => fakeSocket(1, "convenor");

describe("a client write of the Site URL", () => {
  it("reverts an address with no scheme", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("url", "example.org"); }, convenor());
    expect(h.config.get("url")).toBe("https://real.example.org");
  });

  it("reverts an address that carries a path", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("url", "https://example.org/site"); }, convenor());
    expect(h.config.get("url")).toBe("https://real.example.org");
  });

  it("reverts an emptied address and a deleted one", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("url", ""); }, convenor());
    expect(h.config.get("url")).toBe("https://real.example.org");
    h.ydoc.transact(() => { h.config.delete("url"); }, convenor());
    expect(h.config.get("url")).toBe("https://real.example.org");
  });

  it("keeps a valid address", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("url", "https://new.example.org"); }, convenor());
    expect(h.config.get("url")).toBe("https://new.example.org");
    expect(h.warns.length).toBe(0);
  });

  it("keeps a stored address the rules would refuse while it is unchanged", () => {
    const h = makeHarness({ ...STORED, url: "example.org" });
    h.ydoc.transact(() => {
      h.config.set("url", "example.org");
      h.config.set("title", "Otro título");
    }, convenor());
    expect(h.config.get("url")).toBe("example.org");
    expect(h.config.get("title")).toBe("Otro título");
    expect(h.warns.length).toBe(0);
  });

  it("does not judge a server-origin write", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("url", "example.org"); }, null);
    expect(h.config.get("url")).toBe("example.org");
  });
});

describe("a client write of the Base URL", () => {
  it("reverts a path without its leading slash", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("baseurl", "sitio-nuevo"); }, convenor());
    expect(h.config.get("baseurl")).toBe("/sitio");
  });

  it("keeps a valid path and keeps an empty one", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("baseurl", "/nuevo"); }, convenor());
    expect(h.config.get("baseurl")).toBe("/nuevo");
    h.ydoc.transact(() => { h.config.set("baseurl", ""); }, convenor());
    expect(h.config.get("baseurl")).toBe("");
  });

  it("keeps a stored path the rules would refuse while it is unchanged", () => {
    const h = makeHarness({ ...STORED, baseurl: "sitio/" });
    h.ydoc.transact(() => { h.config.set("baseurl", "sitio/"); h.config.set("title", "x"); }, convenor());
    expect(h.config.get("baseurl")).toBe("sitio/");
    expect(h.warns.length).toBe(0);
  });
});

describe("a collaborator's write of an address", () => {
  it("is reverted once, as one config write", () => {
    const h = makeHarness(STORED);
    h.ydoc.transact(() => { h.config.set("url", "example.org"); }, fakeSocket(2, "collaborator"));
    expect(h.config.get("url")).toBe("https://real.example.org");
    expect(h.warns.join("\n")).toContain("reverted 1 convenor-only config write(s)");
  });
});
