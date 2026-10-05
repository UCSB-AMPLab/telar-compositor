/**
 * What the cold-load blob backfill replaced, said out loud.
 *
 * `backfillBlobGaps` seeds four editable prose keys — `object_type`,
 * `subjects`, `source`, `credit` — from D1 whenever the document's own key
 * holds anything that is not a `Y.Text`. It was written for blobs serialized
 * before those keys round-tripped through the snapshot, and it acted in
 * silence, so a load that repaired four thousand keys and a load that repaired
 * none looked the same from outside.
 *
 * Two states reach the seed and the author is neither of them:
 *
 *   - THE KEY IS ABSENT. A document older than the field, which is the
 *     population the repair exists for, or a client deleting the key straight
 *     over the sync protocol. Clearing a field in the editor does not produce
 *     this: `getYText` returns the value only while it is a `Y.Text`, so a
 *     field is editable only while it holds one, and clearing empties the text
 *     in place.
 *   - THE KEY HOLDS SOMETHING ELSE. A value nothing in this product writes
 *     there. The seed replaces it, and that is the case worth an error rather
 *     than a warning, on the same terms `reportConfigHold` uses for config.
 *
 * Both are counted, because the absent count is the size of the population the
 * repair is for and the only measurement that can say it has nothing left to
 * do.
 *
 * The load is the real one: the D1 is the repository's own migration chain in
 * memory, and the blob goes through `ensureDocLoaded`, so a change that stopped
 * calling the backfill fails here rather than passing on a method nobody runs.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(async () => ""),
  getFileAtRef: vi.fn(async () => ({ status: "absent" as const })),
  getRepoTree: vi.fn(async () => ({ tree: [] as unknown[] })),
  getRepoHead: vi.fn(async () => null),
}));

import { createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";
import { seedProject, buildDoc, locate, loadProject, seededText } from "./helpers/collaboration-fixture";

/** A console spy, typed by the calls it records rather than by the console. */
type Spy = { mock: { calls: unknown[][] }; mockRestore: () => void };

let memory: MemoryD1;
let warned: Spy;
let errored: Spy;

beforeEach(() => {
  memory = createMemoryD1();
  warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  errored = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warned.mockRestore();
  errored.mockRestore();
});

/** The whole document, with `edit` applied to the objects Y.Map before it is encoded. */
function blobWithObjects(edit: (objects: Y.Map<unknown>) => void): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, buildDoc(true));
  doc.transact(() => { edit(locate(doc).objects); });
  return Y.encodeStateAsUpdate(doc);
}

/** Every `[shape]` line one of the spies collected, as strings. */
function lines(spy: Spy): string[] {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes("arm=blob-backfill"));
}

describe("the blob backfill reports the keys it seeded", () => {
  it("warns for a key the document never carried, and seeds D1's value", async () => {
    seedProject(memory, "text");
    const { doInstance } = await loadProject(memory, blobWithObjects((objects) => {
      objects.delete("source");
    }));

    expect(lines(errored)).toEqual([]);
    const [line, ...rest] = lines(warned);
    expect(rest).toEqual([]);
    expect(line).toContain("arm=blob-backfill root=objects");
    expect(line).toContain("source (undefined) ×1");
    // Only the key that was missing: a healthy sibling is not in the line.
    expect(line).not.toContain("credit");

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const seeded = locate(ydoc).objects.get("source");
    expect(seeded).toBeInstanceOf(Y.Text);
    expect((seeded as Y.Text).toString()).toBe(seededText("objects", "source"));
  });

  it("errors for a key that held a value, and says how many did", async () => {
    seedProject(memory, "text");
    await loadProject(memory, blobWithObjects((objects) => {
      objects.set("credit", new Y.Map());
    }));

    expect(lines(warned)).toEqual([]);
    const [line, ...rest] = lines(errored);
    expect(rest).toEqual([]);
    expect(line).toContain("credit (Y.Map) ×1");
    expect(line).toContain("1 of them held a value, which is gone");
  });

  it("names the type and never the value", async () => {
    seedProject(memory, "text");
    await loadProject(memory, blobWithObjects((objects) => {
      objects.set("subjects", "una cadena plantada");
    }));

    const [line] = lines(errored);
    expect(line).toContain("subjects (string) ×1");
    expect(line).not.toContain("una cadena plantada");
  });

  it("says nothing about a document whose four keys all hold a Y.Text", async () => {
    seedProject(memory, "text");
    await loadProject(memory, buildDoc(true));

    expect(lines(warned)).toEqual([]);
    expect(lines(errored)).toEqual([]);
  });
});
