/**
 * `/ingest-sync`'s `steps.captureKeptColumns` arm, against the real
 * collaboration object and D1.
 *
 * A publish sends the kept columns it read from a story's CSV for steps that
 * never recorded any. The arm writes them only while the live story is the
 * one the publish aligned against (its raw canonical hash equals `expected`),
 * and only onto a step whose live `extra_columns` records none. It answers
 * once the capture is in D1 and broadcast, so D1 is read here straight after
 * the answer with no snapshot of the tests' own.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { signInternalMarker } from "../../workers/auth";
import { orderedMaps } from "~/lib/field-order";
import { canonicalRaw, contentFromRows } from "~/lib/story-canonical";
import { carryKeptCells } from "~/lib/kept-columns-capture.server";
import type { CaptureLayerRow, CaptureStepRow } from "~/lib/kept-columns-capture.server";
import { rawCanonicalFromD1 } from "~/lib/story-content.server";
import { storyRowsFromFiles } from "~/lib/story-file-rows.server";
import { plantHalt } from "../helpers/halted-document";
import {
  MESSAGE_SYNC,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
} from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";
const touched = new Set<DurableObjectStub>();

afterEach(async () => {
  for (const stub of touched) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "test over"); } catch { /* already closed */ }
      }
    });
  }
  touched.clear();
});

async function post(fixture: Fixture, path: string, action: string, body?: unknown) {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, action);
  const response = await stubFor(fixture.projectId).fetch(
    new Request(`https://internal${path}`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(fixture.projectId),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

async function storyRowId(fixture: Fixture, storyId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM stories WHERE project_id = ? AND story_id = ?")
    .bind(fixture.projectId, storyId)
    .first<{ id: number }>();
  return row!.id;
}

/** Steps written to D1 as a snapshot would hold them; returns their ids in order. */
async function seedSteps(storyDbId: number, steps: Array<{ question: string; extra?: string }>): Promise<number[]> {
  const ids: number[] = [];
  for (const [i, s] of steps.entries()) {
    const row = await env.DB.prepare(
      `INSERT INTO steps (story_id, step_number, order_key, kind, object_id, question, answer, extra_columns)
       VALUES (?, ?, ?, 'media', 'obj', ?, '', ?) RETURNING id`,
    )
      .bind(storyDbId, i + 1, `a${i}`, s.question, s.extra ?? null)
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  return ids;
}

async function extras(stepIds: number[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const id of stepIds) {
    const row = await env.DB.prepare("SELECT extra_columns FROM steps WHERE id = ?").bind(id).first<{ extra_columns: string | null }>();
    out.push(row?.extra_columns ?? null);
  }
  return out;
}

/** The raw-form hash the publish sends: D1's rows, canonicalised in order. */
async function expectedHash(storyDbId: number): Promise<string> {
  const steps = (await env.DB.prepare("SELECT * FROM steps WHERE story_id = ?").bind(storyDbId).all()).results;
  const layers = (await env.DB.prepare(
    "SELECT * FROM layers WHERE step_id IN (SELECT id FROM steps WHERE story_id = ?)",
  ).bind(storyDbId).all()).results;
  const raw = await canonicalRaw(contentFromRows(steps as never, layers as never));
  if (!raw.readable) throw new Error(JSON.stringify(raw.reason));
  return raw.hash;
}

function capture(entries: unknown[]) {
  return { steps: { captureKeptColumns: entries } };
}

const NOTE = JSON.stringify({ note: "from the CSV" });
const RECORDED = JSON.stringify({ note: "recorded here" });

async function setup(label: string, steps: Array<{ question: string; extra?: string }>) {
  const fixture = await seedProject(label);
  touched.add(stubFor(fixture.projectId));
  const storyDbId = await storyRowId(fixture, "s1");
  const ids = await seedSteps(storyDbId, steps);
  return { fixture, storyDbId, ids, expected: await expectedHash(storyDbId) };
}

describe("steps.captureKeptColumns", () => {
  it("fills a step that records no kept columns, in D1 before it answers", async () => {
    const { fixture, ids, expected } = await setup("kc-fill", [{ question: "A" }, { question: "B" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "s1", expected, steps: [{ stepId: ids[1], extra_columns: NOTE }] },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.keptColumns).toEqual({ captured: ["s1"], changed: [], missing: [], failed: [] });
    expect(await extras(ids)).toEqual([null, NOTE]);
  });

  it("leaves a step that already records kept columns as it is", async () => {
    const { fixture, ids, expected } = await setup("kc-recorded", [{ question: "A", extra: RECORDED }, { question: "B" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }, { stepId: ids[1], extra_columns: NOTE }] },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.keptColumns.captured).toEqual(["s1"]);
    expect(await extras(ids)).toEqual([RECORDED, NOTE]);
  });

  it("leaves a step whose last kept column was removed: \"{}\" is recorded, and the column stays out", async () => {
    const { fixture, ids, expected } = await setup("kc-removed", [{ question: "A", extra: "{}" }, { question: "B" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }, { stepId: ids[1], extra_columns: NOTE }] },
    ]));
    expect(res.status).toBe(200);
    expect(await extras(ids)).toEqual(["{}", NOTE]);
  });

  it("writes nothing to a story edited since the publish read it, and reports it changed", async () => {
    const { fixture, ids, expected } = await setup("kc-changed", [{ question: "A" }, { question: "B" }]);
    await post(fixture, "/snapshot", "snapshot");
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
      const step = orderedMaps(story.get("steps"))[0];
      ydoc.transact(() => (step.get("question") as Y.Text).insert(1, ", edited live"));
    });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "s1", expected, steps: [{ stepId: ids[1], extra_columns: NOTE }] },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.keptColumns).toEqual({ captured: [], changed: ["s1"], missing: [], failed: [] });
    expect(await extras(ids)).toEqual([null, null]);
    const live = await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
      return orderedMaps(story.get("steps")).map((s) => s.get("extra_columns"));
    });
    expect(live).toEqual(["", ""]);
  });

  it("reports a step of another story, or one that does not exist, as missing and writes nothing", async () => {
    const { fixture, ids, expected } = await setup("kc-owner", [{ question: "A" }]);
    await env.DB.prepare("INSERT INTO stories (project_id, story_id, title) VALUES (?, 's2', 'Other')")
      .bind(fixture.projectId).run();
    const [otherStep] = await seedSteps(await storyRowId(fixture, "s2"), [{ question: "Z" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }, { stepId: otherStep, extra_columns: NOTE }] },
      { storyId: "nope", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }] },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.keptColumns).toEqual({ captured: [], changed: [], missing: ["s1", "nope"], failed: [] });
    expect(await extras([ids[0], otherStep])).toEqual([null, null]);
  });

  it("refuses by position an entry with a bad identity, step id or blob", async () => {
    const { fixture, ids, expected } = await setup("kc-refused", [{ question: "A" }]);
    const good = { stepId: ids[0], extra_columns: NOTE };
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "", expected, steps: [good] },
      { storyId: "s1", expected, steps: [{ stepId: 1.5, extra_columns: NOTE }] },
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: "not json" }] },
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: JSON.stringify({ note: 1 }) }] },
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: "{}" }] },
      { storyId: "s1", expected, steps: [good, good] },
      { storyId: "s1", steps: [good] },
      { storyId: "s1", expected },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.refused.stepCaptureKeptColumns).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(res.body.keptColumns).toEqual({ captured: [], changed: [], missing: [], failed: [] });
    expect(await extras(ids)).toEqual([null]);
  });

  it("refuses an operation id sent beside it", async () => {
    const { fixture, ids, expected } = await setup("kc-opid", [{ question: "A" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", {
      opId: 1, ...capture([{ storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }] }]),
    });
    expect(res.status).toBe(400);
  });

  it("refuses, with 400 and nothing applied, a capture sent beside another arm", async () => {
    const { fixture, ids, expected } = await setup("kc-alone", [{ question: "A" }]);
    const entry = { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }] };
    const replaced = {
      stories: {
        update: [{ storyId: "s1", title: "A new title" }],
        insert: [],
        replaceContent: [{
          storyId: "s1", expected,
          steps: [{ step_number: 1, kind: "media", object_id: "obj", question: "A, edited on GitHub", answer: "" }],
          layers: [],
        }],
      },
    };
    for (const beside of [replaced, { stories: { update: [], insert: [] } }, { config: [] }, { objects: { update: [], insert: [], remove: [] } }]) {
      const res = await post(fixture, "/ingest-sync", "ingest-sync", { ...beside, ...capture([entry]) });
      expect(res.status).toBe(400);
    }
    expect(await extras(ids)).toEqual([null]);
    const row = await env.DB.prepare("SELECT question FROM steps WHERE id = ?").bind(ids[0]).first<{ question: string }>();
    expect(row!.question).toBe("A");
    const title = await env.DB.prepare("SELECT title FROM stories WHERE project_id = ? AND story_id = 's1'")
      .bind(fixture.projectId).first<{ title: string }>();
    expect(title!.title).toBe(fixture.storyTitle);
  });

  it("answers 503 persistence_halted on a halted document and writes nothing", async () => {
    const { fixture, ids, expected } = await setup("kc-halt", [{ question: "A" }]);
    await post(fixture, "/snapshot", "snapshot");
    await runInDurableObject(stubFor(fixture.projectId), (instance) => plantHalt(instance));
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }] },
    ]));
    expect(res.status).toBe(503);
    expect(res.body).toBe("persistence_halted");
    expect(await extras(ids)).toEqual([null]);
  });

  it("broadcasts the capture to connected editors before it answers", async () => {
    const { fixture, ids, expected } = await setup("kc-broadcast", [{ question: "A" }]);
    const socket = await openSocket(fixture, "0");
    const state = await drainAcceptanceFrames(socket);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      { storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }] },
    ]));
    expect(res.status).toBe(200);
    const frame = decoding.createDecoder(await socket.next());
    expect(decoding.readVarUint(frame)).toBe(MESSAGE_SYNC);
    const editor = new Y.Doc();
    Y.applyUpdate(editor, state);
    syncProtocol.readSyncMessage(frame, encoding.createEncoder(), editor, "server");
    const story = editor.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
    expect(orderedMaps(story.get("steps")).map((s) => s.get("extra_columns"))).toEqual([NOTE]);
    socket.ws.close();
  });

  it("captures the payload the publish's own producer builds from the rows the worker holds", async () => {
    const fixture = await seedProject("kc-producer");
    touched.add(stubFor(fixture.projectId));
    const storyDbId = await storyRowId(fixture, "s1");
    const ids = await seedSteps(storyDbId, [{ question: "Primera" }, { question: "Segunda" }, { question: "Nueva" }]);
    await env.DB.prepare(
      `INSERT INTO layers (step_id, layer_number, order_key, title, button_label, content) VALUES (?, 1, 'a0', '', 'Más', 'Un panel')`,
    ).bind(ids[0]).run();
    // Post-snapshot: the rows as the forced snapshot leaves them.
    expect((await post(fixture, "/snapshot", "snapshot")).status).toBe(200);
    const stepRows = (await env.DB.prepare(
      "SELECT id, step_number, order_key, kind, object_id, x, y, zoom, page, question, answer, alt_text, clip_start, clip_end, loop, extra_columns FROM steps WHERE story_id = ?",
    ).bind(storyDbId).all()).results as unknown as CaptureStepRow[];
    const layerRows = (await env.DB.prepare(
      "SELECT step_id, layer_number, order_key, title, button_label, content FROM layers WHERE step_id IN (SELECT id FROM steps WHERE story_id = ?)",
    ).bind(storyDbId).all()).results as unknown as CaptureLayerRow[];

    // The CSV the story was imported from, with an author's column; its
    // second step was deleted in the Compositor and the third is new there.
    const csv =
      "step,object,question,answer,layer1_button,layer1_content,Nota del autor\n" +
      "1,obj,Primera,,Más,Un panel,una nota\n" +
      "2,obj,Borrada,,,,sin paso\n" +
      "3,obj,Segunda,,,,otra nota\n";
    const file = await storyRowsFromFiles("s1", csv, {}, {});
    const { steps } = await carryKeptCells({ stepRows, layerRows }, file);
    const raw = await rawCanonicalFromD1(stepRows, layerRows);
    if (!raw.readable) throw new Error(JSON.stringify(raw.reason));

    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{ storyId: "s1", expected: raw.hash, steps }]));
    expect(res.status).toBe(200);
    expect(res.body.keptColumns).toEqual({ captured: ["s1"], changed: [], missing: [], failed: [] });
    expect((await extras(ids)).map((e) => (e === null ? null : JSON.parse(e)))).toEqual([
      { "Nota del autor": "una nota" },
      { "Nota del autor": "otra nota" },
      null,
    ]);
  });

  // -------------------------------------------------------------------------
  // Rows the Compositor never had
  // -------------------------------------------------------------------------

  /** The story's steps in D1, in the order a publish reads them. */
  async function storySteps(storyDbId: number) {
    return (await env.DB.prepare(
      "SELECT id, kind, object_id, question, page, clip_start, x, extra_columns, order_key FROM steps WHERE story_id = ? ORDER BY order_key, id",
    ).bind(storyDbId).all<{
      id: number; kind: string; object_id: string | null; question: string | null; page: string | null;
      clip_start: string | null; x: number | null; extra_columns: string | null; order_key: string;
    }>()).results;
  }

  const ROW = (text: string) => JSON.stringify({ notes: text });

  it("inserts a section step after the step it names, holding the row's cells, in D1 before it answers", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert", [{ question: "A" }, { question: "B" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
      storyId: "s1", expected, steps: [],
      inserts: [{ afterStepId: ids[0], step: { page: "2", clip_start: "15", x: 0.25, extra_columns: ROW("between") } }],
    }]));
    expect(res.status).toBe(200);
    expect(res.body.keptColumns).toEqual({ captured: ["s1"], changed: [], missing: [], failed: [] });
    const rows = await storySteps(storyDbId);
    expect(rows.map((r) => r.question ?? "")).toEqual(["A", "", "B"]);
    expect(rows[1]).toMatchObject({ kind: "section", page: "2", clip_start: "15", x: 0.25, extra_columns: ROW("between") });
    expect(rows[1].object_id ?? "").toBe("");
  });

  it("puts an insert naming no step first, and keeps the order of inserts after one step", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert-order", [{ question: "A" }, { question: "B" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
      storyId: "s1", expected, steps: [],
      inserts: [
        { afterStepId: null, step: { extra_columns: ROW("1") } },
        { afterStepId: null, step: { extra_columns: ROW("2") } },
        { afterStepId: ids[0], step: { extra_columns: ROW("3") } },
        { afterStepId: ids[0], step: { extra_columns: ROW("4") } },
        { afterStepId: ids[0], step: { extra_columns: ROW("5") } },
      ],
    }]));
    expect(res.body.keptColumns.captured).toEqual(["s1"]);
    const rows = await storySteps(storyDbId);
    expect(rows.map((r) => r.question || JSON.parse(r.extra_columns!).notes)).toEqual(["1", "2", "A", "3", "4", "5", "B"]);
  });

  it("inserts every row of a story that has no steps", async () => {
    const { fixture, storyDbId, expected } = await setup("kc-insert-empty", []);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
      storyId: "s1", expected, steps: [],
      inserts: [{ afterStepId: null, step: { extra_columns: ROW("1") } }, { afterStepId: null, step: { extra_columns: ROW("2") } }],
    }]));
    expect(res.body.keptColumns.captured).toEqual(["s1"]);
    expect((await storySteps(storyDbId)).map((r) => JSON.parse(r.extra_columns!).notes)).toEqual(["1", "2"]);
  });

  it("inserts between two steps whose order keys are equal, re-keying them in their live order", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert-tie", [{ question: "A" }, { question: "B" }, { question: "C" }]);
    await post(fixture, "/snapshot", "snapshot");
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
      const [a, b] = orderedMaps(story.get("steps"));
      ydoc.transact(() => b.set("order_key", a.get("order_key")));
    });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
      storyId: "s1", expected, steps: [], inserts: [{ afterStepId: ids[0], step: { extra_columns: ROW("between") } }],
    }]));
    expect(res.body.keptColumns.captured).toEqual(["s1"]);
    const rows = await storySteps(storyDbId);
    expect(rows.map((r) => r.question || "row")).toEqual(["A", "row", "B", "C"]);
    const keys = rows.map((r) => r.order_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("mints the insert's key above the step it follows, not only below the next one", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert-bounds", [{ question: "A" }, { question: "B" }, { question: "C" }]);
    await post(fixture, "/snapshot", "snapshot");
    // Keys a mint bounded by the next step alone would fall below B's.
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
      const [a, b, c] = orderedMaps(story.get("steps"));
      ydoc.transact(() => { a.set("order_key", "a0"); b.set("order_key", "a1zz"); c.set("order_key", "a2"); });
    });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
      storyId: "s1", expected, steps: [], inserts: [{ afterStepId: ids[1], step: { extra_columns: ROW("after B") } }],
    }]));
    expect(res.body.keptColumns.captured).toEqual(["s1"]);
    expect((await storySteps(storyDbId)).map((r) => r.question || "row")).toEqual(["A", "B", "row", "C"]);
  });

  it("inserts nothing into a story edited since the publish read it", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert-changed", [{ question: "A" }]);
    await post(fixture, "/snapshot", "snapshot");
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
      ydoc.transact(() => (orderedMaps(story.get("steps"))[0].get("question") as Y.Text).insert(1, ", edited live"));
    });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
      storyId: "s1", expected, steps: [], inserts: [{ afterStepId: ids[0], step: { extra_columns: ROW("x") } }],
    }]));
    expect(res.body.keptColumns).toEqual({ captured: [], changed: ["s1"], missing: [], failed: [] });
    expect(await storySteps(storyDbId)).toHaveLength(1);
  });

  it("reports an insert after a step the story does not hold as missing, and inserts nothing", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert-missing", [{ question: "A" }]);
    await env.DB.prepare("INSERT INTO stories (project_id, story_id, title) VALUES (?, 's2', 'Other')").bind(fixture.projectId).run();
    const [otherStep] = await seedSteps(await storyRowId(fixture, "s2"), [{ question: "Z" }]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
      storyId: "s1", expected, steps: [{ stepId: ids[0], extra_columns: NOTE }],
      inserts: [{ afterStepId: otherStep, step: { extra_columns: ROW("x") } }],
    }]));
    expect(res.body.keptColumns).toEqual({ captured: [], changed: [], missing: ["s1"], failed: [] });
    expect(await storySteps(storyDbId)).toHaveLength(1);
    expect(await extras(ids)).toEqual([null]);
  });

  it("reports an insert D1 did not take as failed", async () => {
    const { fixture, ids, expected } = await setup("kc-insert-failed", [{ question: "A" }]);
    await env.DB.prepare(
      "CREATE TRIGGER refuse_row BEFORE INSERT ON steps WHEN NEW.extra_columns LIKE '%refused%' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ).run();
    try {
      const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
        storyId: "s1", expected, steps: [], inserts: [{ afterStepId: ids[0], step: { extra_columns: ROW("refused") } }],
      }]));
      expect(res.status).toBe(200);
      expect(res.body.keptColumns).toEqual({ captured: [], changed: [], missing: [], failed: ["s1"] });
    } finally {
      await env.DB.prepare("DROP TRIGGER refuse_row").run();
    }
  });

  it("reports an insert as failed when its D1 row does not hold its cells", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert-scrubbed", [{ question: "A" }]);
    await env.DB.prepare(
      "CREATE TRIGGER scrub_row AFTER INSERT ON steps WHEN NEW.extra_columns LIKE '%scrubbed%' BEGIN UPDATE steps SET extra_columns = NULL WHERE id = NEW.id; END",
    ).run();
    try {
      const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{
        storyId: "s1", expected, steps: [], inserts: [{ afterStepId: ids[0], step: { extra_columns: ROW("scrubbed") } }],
      }]));
      expect(res.status).toBe(200);
      expect(res.body.keptColumns).toEqual({ captured: [], changed: [], missing: [], failed: ["s1"] });
      expect(await storySteps(storyDbId)).toHaveLength(2);
    } finally {
      await env.DB.prepare("DROP TRIGGER scrub_row").run();
    }
  });

  it("refuses by position an insert with a bad step id, place or blob", async () => {
    const { fixture, storyDbId, ids, expected } = await setup("kc-insert-refused", [{ question: "A" }]);
    const entry = (insert: unknown) => ({ storyId: "s1", expected, steps: [], inserts: [insert] });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([
      entry({ afterStepId: 0, step: { extra_columns: ROW("x") } }),
      entry({ afterStepId: "1", step: { extra_columns: ROW("x") } }),
      entry({ step: { extra_columns: ROW("x") } }),
      entry({ afterStepId: ids[0], step: { extra_columns: "{}" } }),
      entry({ afterStepId: ids[0], step: {} }),
      entry({ afterStepId: ids[0], step: { extra_columns: ROW("x"), page: 2 } }),
      entry({ afterStepId: ids[0] }),
      entry(null),
      { storyId: "s1", expected, steps: [], inserts: {} },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.refused.stepCaptureKeptColumns).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await storySteps(storyDbId)).toHaveLength(1);
  });

  it("captures a story imported before custom columns were kept in the template's layout, as the publish's producer builds it", async () => {
    const fixture = await seedProject("kc-insert-producer");
    touched.add(stubFor(fixture.projectId));
    const storyDbId = await storyRowId(fixture, "s1");
    // The template's story layout (your-story.csv), an author's `notes`
    // column added, and a row the author added with only a note in it.
    const csvText =
      "step,object,x,y,zoom,page,question,answer,layer1_button,layer1_content,layer2_button,layer2_content,clip_start,clip_end,loop,notes\n" +
      "paso,objeto,x,y,zoom,pagina,pregunta,respuesta,boton1,contenido1,boton2,contenido2,inicio_clip,fin_clip,bucle,\n" +
      "1,atlas-allegory,0.5,0.5,1,,What is this image?,The engraving.,,,,,,,,on the image\n" +
      "2,,,,,,,,,,,,,,,Check the plate number\n" +
      "3,atlas-allegory,0.486,0.277,10,,Consider the necklace,The chain is made of ships.,,,,,,,,\n";
    const file = await storyRowsFromFiles("s1", csvText, {}, {});
    // As the earlier import left it: the custom-only row skipped, nothing kept.
    const ids: number[] = [];
    for (const [rank, index] of [0, 2].entries()) {
      const s = file.stepRows[index];
      const row = await env.DB.prepare(
        `INSERT INTO steps (story_id, step_number, order_key, kind, object_id, x, y, zoom, question, answer)
         VALUES (?, ?, ?, 'media', ?, ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(storyDbId, rank + 1, `a${rank}`, s.object_id, s.x, s.y, s.zoom, s.question, s.answer).first<{ id: number }>();
      ids.push(row!.id);
    }
    expect((await post(fixture, "/snapshot", "snapshot")).status).toBe(200);
    const stepRows = (await env.DB.prepare(
      "SELECT id, step_number, order_key, kind, object_id, x, y, zoom, page, question, answer, alt_text, clip_start, clip_end, loop, extra_columns FROM steps WHERE story_id = ?",
    ).bind(storyDbId).all()).results as unknown as CaptureStepRow[];
    const { steps, inserts } = await carryKeptCells({ stepRows, layerRows: [] }, file);
    const raw = await rawCanonicalFromD1(stepRows, []);
    if (!raw.readable) throw new Error(JSON.stringify(raw.reason));

    const res = await post(fixture, "/ingest-sync", "ingest-sync", capture([{ storyId: "s1", expected: raw.hash, steps, inserts }]));
    expect(res.status).toBe(200);
    expect(res.body.keptColumns.captured).toEqual(["s1"]);
    const rows = await storySteps(storyDbId);
    expect(rows.map((r) => [r.question ?? "", r.extra_columns && JSON.parse(r.extra_columns).notes])).toEqual([
      ["What is this image?", "on the image"],
      ["", "Check the plate number"],
      ["Consider the necklace", null],
    ]);
    expect(rows[0].id).toBe(ids[0]);
  });
});
