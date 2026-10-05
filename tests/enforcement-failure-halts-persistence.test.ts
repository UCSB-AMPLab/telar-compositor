/**
 * A revert that could not be applied leaves a refused deletion in the
 * document. Snapshotting that document writes the deletion into D1 and
 * destroys the row the revert existed to protect, so persistence stops
 * instead.
 *
 * The halt is deliberately recoverable rather than terminal: D1 never received
 * the deletion, and `/reset` rebuilds the document from those same rows, so a
 * landed replacement clears a halt the generation it supersedes. What must
 * never happen is a snapshot that reports success while refusing to write —
 * every route that asks for a flush gets `false` and answers 503.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: unknown; env: unknown; constructor(c: unknown, e: unknown) { this.ctx = c; this.env = e; } },
}));

import { ProjectCollaborationDO } from "../workers/collaboration";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { markLoaded } from "./helpers/claimed-document";
import { plantHalt } from "./helpers/halted-document";

const here = dirname(fileURLToPath(import.meta.url));

function makeDO() {
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const env = { DB: {} as unknown, SESSION_SECRET: "s", COLLABORATION: {} as unknown };
  const d = new ProjectCollaborationDO(ctx as unknown as DurableObjectState, env as unknown as Env);
  return d as unknown as {
    persistenceHalted: unknown;
    projectId: number | null;
    docLoaded: boolean;
    snapshotToD1: () => Promise<void>;
    flushSnapshotNow: () => Promise<boolean>;
    doSnapshot: () => Promise<void>;
    ydoc: Y.Doc;
  };
}

describe("a failed revert halts persistence", () => {
  it("does not snapshot while the document holds a refused deletion", async () => {
    const d = makeDO();
    d.projectId = 1;
    markLoaded(d);
    const doSnapshot = vi.fn(async () => {});
    d.doSnapshot = doSnapshot;

    await d.snapshotToD1();
    expect(doSnapshot).toHaveBeenCalledTimes(1); // healthy: it snapshots

    plantHalt(d);
    await d.snapshotToD1();
    expect(doSnapshot).toHaveBeenCalledTimes(1); // halted: no second call
  });

  it("refuses the flush rather than reporting one, so the route answers 503", async () => {
    const d = makeDO();
    d.projectId = 1;
    markLoaded(d);
    d.doSnapshot = vi.fn(async () => {});

    expect(await d.flushSnapshotNow()).toBe(true);
    plantHalt(d);
    expect(await d.flushSnapshotNow()).toBe(false);
  });

  it("supplies the callback the rule needs to reach the halt, and clears it on reset", () => {
    // The flag is only reachable if the DO actually passes the callback, and a
    // dep that is quietly dropped fails silently — nothing goes red, the halt
    // simply never fires. There is no behavioural seam for this (the handler
    // is constructed inside the constructor), so this reads the source, the
    // way `skip-stories-plumbing` does for the config action.
    const src = readFileSync(join(here, "..", "workers", "collaboration.ts"), "utf-8");
    const wiring = src.slice(src.indexOf("makeCanDeleteHandler({"));
    expect(wiring.slice(0, wiring.indexOf("}));"))).toMatch(/onEnforcementFailure:/);
    // It must reach the halt, not merely log.
    expect(src).toMatch(/private haltOnEnforcementFailure[\s\S]*?this\.enterHalt\("enforcement_failed"/);
    // And the reset path must clear a halt its replacement supersedes, or the
    // halt is terminal rather than recoverable and the project can never be
    // persisted again.
    expect(src).toMatch(/this\.persistenceHalted\s*=\s*null/);
  });
});
