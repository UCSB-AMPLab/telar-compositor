/**
 * `/ingest-sync`'s `stories.replaceContent` arm, against the real
 * collaboration object and D1.
 *
 * Each entry replaces a story's steps and layers with what GitHub holds, but
 * only while the live story is still the one the author reviewed: the raw
 * canonical hash of its live maps, in `order_key` order, must equal the
 * entry's `expected`. The steps are aligned by content, so a step the same on
 * both sides keeps its map, its D1 id and its authorship, and the accepted
 * sequence is the stored order.
 *
 * D1 is read straight after the ingest answers, with no snapshot of the
 * tests' own: the ingest's flush is what is under test, and a story is
 * reported applied only once D1 shows it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { signInternalMarker } from "../../workers/auth";
import { orderedMaps } from "~/lib/field-order";
import { canonicalRaw, contentFromRows } from "~/lib/story-canonical";
import { seedProject, stubFor, type Fixture } from "./helpers/collaboration-client";

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

interface SeedStep {
  question: string;
  kind?: "media" | "section";
  answer?: string;
  layers?: Array<{ title: string; content: string }>;
}

/** Steps and layers written to D1 as a snapshot would hold them, by `fixture.userId`. */
async function seedSteps(fixture: Fixture, steps: SeedStep[]): Promise<number> {
  const story = await env.DB.prepare("SELECT id FROM stories WHERE project_id = ? AND story_id = 's1'")
    .bind(fixture.projectId)
    .first<{ id: number }>();
  for (const [i, s] of steps.entries()) {
    const row = await env.DB.prepare(
      `INSERT INTO steps (story_id, step_number, order_key, kind, object_id, question, answer, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(story!.id, i + 1, `a${i}`, s.kind ?? "media", s.kind === "section" ? "" : "obj", s.question, s.answer ?? "", fixture.userId)
      .first<{ id: number }>();
    for (const [j, l] of (s.layers ?? []).entries()) {
      await env.DB.prepare(
        `INSERT INTO layers (step_id, layer_number, order_key, title, button_label, content, created_by)
         VALUES (?, ?, ?, ?, 'More', ?, ?)`,
      )
        .bind(row!.id, j + 1, `a${j}`, l.title, l.content, fixture.userId)
        .run();
    }
  }
  return story!.id;
}

interface StepRow {
  id: number; step_number: number; order_key: string | null; kind: string; object_id: string; x: number | null;
  y: number | null; zoom: number | null; page: string | null; question: string; answer: string; alt_text: string | null;
  clip_start: string | null; clip_end: string | null; loop: string | null; extra_columns: string | null; created_by: number | null;
}
interface LayerRow {
  id: number; step_id: number; layer_number: number; order_key: string | null; title: string; button_label: string;
  content: string; created_by: number | null;
}

async function d1Rows(storyId: number) {
  const steps = (await env.DB.prepare("SELECT * FROM steps WHERE story_id = ? ORDER BY order_key, id").bind(storyId).all<StepRow>()).results;
  const layers: LayerRow[] = [];
  for (const s of steps) {
    layers.push(...(await env.DB.prepare("SELECT * FROM layers WHERE step_id = ? ORDER BY order_key, id").bind(s.id).all<LayerRow>()).results);
  }
  return { steps, layers };
}

/** The raw-form hash the check records: D1's rows, canonicalised in order. */
async function expectedHash(storyId: number): Promise<string> {
  const { steps, layers } = await d1Rows(storyId);
  const raw = await canonicalRaw(contentFromRows(steps, layers));
  if (!raw.readable) throw new Error(JSON.stringify(raw.reason));
  return raw.hash;
}

function incoming(steps: SeedStep[]) {
  return {
    steps: steps.map((s, i) => ({
      step_number: i + 1,
      kind: s.kind ?? "media",
      object_id: s.kind === "section" ? "" : "obj",
      question: s.question,
      answer: s.answer ?? "",
    })),
    layers: steps.flatMap((s, i) =>
      (s.layers ?? []).map((l, j) => ({ step_index: i, layer_number: j + 1, title: l.title, button_label: "More", content: l.content })),
    ),
  };
}

function replace(storyId: string, content: ReturnType<typeof incoming>, expected: string) {
  return { stories: { update: [], insert: [], replaceContent: [{ storyId, ...content, expected }] } };
}

async function setup(label: string, steps: SeedStep[]) {
  const fixture = await seedProject(label);
  touched.add(stubFor(fixture.projectId));
  const storyId = await seedSteps(fixture, steps);
  return { fixture, storyId, before: await d1Rows(storyId), expected: await expectedHash(storyId) };
}

const snapshot = (fixture: Fixture) => post(fixture, "/snapshot", "snapshot");

const A = { question: "A" };
const B = { question: "B" };
const C = { question: "C" };

describe("stories.replaceContent", () => {
  it("keeps an identical step's D1 id and created_by, and updates a changed one in place", async () => {
    const { fixture, storyId, before, expected } = await setup("rc-identical", [A, B, C]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", incoming([A, { question: "B, edited on GitHub" }, C]), expected));
    expect(res.status).toBe(200);
    expect(res.body.content).toMatchObject({ applied: ["s1"], changedSinceReview: [], failed: [] });
    const after = await d1Rows(storyId);
    expect(after.steps.map((s) => [s.id, s.question, s.created_by])).toEqual([
      [before.steps[0].id, "A", fixture.userId],
      [before.steps[1].id, "B, edited on GitHub", fixture.userId],
      [before.steps[2].id, "C", fixture.userId],
    ]);
  });

  it("keeps both steps' ids when a section is inserted before them on GitHub, and inserts one", async () => {
    const { fixture, storyId, before, expected } = await setup("rc-section", [A, B]);
    const section = { question: "A new chapter", kind: "section" as const };
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", incoming([section, A, B]), expected));
    expect(res.status).toBe(200);
    const after = await d1Rows(storyId);
    expect(after.steps.map((s) => s.question)).toEqual(["A new chapter", "A", "B"]);
    expect(after.steps[1].id).toBe(before.steps[0].id);
    expect(after.steps[2].id).toBe(before.steps[1].id);
    expect(before.steps.map((s) => s.id)).not.toContain(after.steps[0].id);
    expect(after.steps.map((s) => s.step_number)).toEqual([1, 2, 3]);
  });

  it("changes nothing when GitHub only renumbered the steps", async () => {
    const { fixture, storyId, expected } = await setup("rc-renumber", [A, B, C]);
    // As a snapshot writes the rows, so the comparison below is of the ingest alone.
    await snapshot(fixture);
    const before = await d1Rows(storyId);
    const content = incoming([A, B, C]);
    content.steps.forEach((s, i) => (s.step_number = (i + 1) * 10));
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", content, expected));
    expect(res.status).toBe(200);
    expect(res.body.content.alreadyApplied).toEqual(["s1"]);
    expect(await d1Rows(storyId)).toEqual(before);
  });

  it("stores the accepted sequence as the order", async () => {
    const { fixture, storyId, expected } = await setup("rc-order", [A, B, C]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", incoming([C, A, B]), expected));
    expect(res.status).toBe(200);
    const after = await d1Rows(storyId);
    expect(after.steps.map((s) => s.question)).toEqual(["C", "A", "B"]);
    const keys = after.steps.map((s) => s.order_key!);
    expect([...keys].sort()).toEqual(keys);
    expect(after.steps.map((s) => s.step_number)).toEqual([1, 2, 3]);
  });

  it("judges the live story by its order, not by step numbers that lag it", async () => {
    const { fixture, storyId, expected } = await setup("rc-lagging", [A, B, C]);
    // Numbers that disagree with the order_key order, as a reorder not yet
    // snapshotted leaves them; the story the author sees is A, B, C.
    await env.DB.prepare("UPDATE steps SET step_number = 4 - step_number WHERE story_id = ?").bind(storyId).run();
    expect(await expectedHash(storyId)).toBe(expected);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", incoming([A, { question: "B, edited on GitHub" }, C]), expected));
    expect(res.body.content).toMatchObject({ applied: ["s1"], changedSinceReview: [] });
    const after = await d1Rows(storyId);
    expect(after.steps.map((s) => [s.question, s.step_number])).toEqual([["A", 1], ["B, edited on GitHub", 2], ["C", 3]]);
  });

  it("sets the kept columns from the incoming steps", async () => {
    const { fixture, storyId, expected } = await setup("rc-extras", [A, B]);
    const content = incoming([A, B]);
    (content.steps[1] as Record<string, unknown>).extra_columns = JSON.stringify({ note: "kept on GitHub" });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", content, expected));
    expect(res.status).toBe(200);
    const after = await d1Rows(storyId);
    expect(JSON.parse(after.steps[1].extra_columns!)).toEqual({ note: "kept on GitHub" });
  });

  it("refuses a story edited after the check, unsnapshotted edits included, and applies nothing of it", async () => {
    const { fixture, storyId, before, expected } = await setup("rc-refused", [A, B]);
    // Load the document, then edit a step in it without a snapshot.
    await post(fixture, "/snapshot", "snapshot");
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
      const step = orderedMaps(story.get("steps"))[0];
      ydoc.transact(() => (step.get("question") as Y.Text).insert(1, ", edited live"));
    });
    const payload = replace("s1", incoming([A, { question: "B, edited on GitHub" }]), expected);
    (payload.stories.update as unknown[]).push({ storyId: "s1", title: "A new title on GitHub" });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", payload);
    expect(res.status).toBe(200);
    expect(res.body.content).toMatchObject({ applied: [], changedSinceReview: ["s1"] });
    const live = await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray().find((m) => m.get("story_id") === "s1")!;
      return {
        title: String(story.get("title")),
        questions: orderedMaps(story.get("steps")).map((s) => String(s.get("question"))),
      };
    });
    expect(live.questions).toEqual(["A, edited live", "B"]);
    expect(live.title).not.toBe("A new title on GitHub");
    const after = await d1Rows(storyId);
    expect(after.steps.map((s) => s.id)).toEqual(before.steps.map((s) => s.id));
  });

  it("treats a replay of an applied entry as a no-op", async () => {
    const { fixture, storyId, expected } = await setup("rc-replay", [A, B]);
    const payload = replace("s1", incoming([A, { question: "B, edited on GitHub" }, C]), expected);
    expect((await post(fixture, "/ingest-sync", "ingest-sync", payload)).body.content.applied).toEqual(["s1"]);
    const once = await d1Rows(storyId);
    const again = await post(fixture, "/ingest-sync", "ingest-sync", payload);
    expect(again.body.content).toMatchObject({ applied: [], alreadyApplied: ["s1"], changedSinceReview: [] });
    expect(await d1Rows(storyId)).toEqual(once);
  });

  it("aligns each step's layers the same way", async () => {
    const withLayers = {
      question: "A",
      layers: [
        { title: "One", content: "First panel." },
        { title: "Two", content: "Second panel." },
      ],
    };
    const { fixture, storyId, before, expected } = await setup("rc-layers", [withLayers]);
    const edited = {
      question: "A",
      layers: [
        { title: "One", content: "First panel." },
        { title: "Two", content: "Second panel, edited." },
        { title: "Three", content: "A third panel." },
      ],
    };
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", incoming([edited]), expected));
    expect(res.status).toBe(200);
    const after = await d1Rows(storyId);
    expect(after.steps[0].id).toBe(before.steps[0].id);
    expect(after.layers.map((l) => [l.title, l.content])).toEqual([
      ["One", "First panel."],
      ["Two", "Second panel, edited."],
      ["Three", "A third panel."],
    ]);
    expect(after.layers[0].id).toBe(before.layers[0].id);
    expect(after.layers[1].id).toBe(before.layers[1].id);
    expect(after.layers[0].created_by).toBe(fixture.userId);
    expect(after.layers.map((l) => l.layer_number)).toEqual([1, 2, 3]);
  });

  it("refuses a malformed entry by position", async () => {
    const { fixture, expected } = await setup("rc-malformed", [A]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", {
      stories: { update: [], insert: [], replaceContent: [{ storyId: "s1", steps: {}, expected }, { storyId: "s1", steps: [], layers: [] }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.refused.storyReplaceContent).toEqual([0, 1]);
  });
  it("sets aside a title update beside a refused entry for the same story", async () => {
    const { fixture } = await setup("rc-refused-title", [A]);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", {
      stories: {
        update: [{ storyId: "s1", title: "A new title on GitHub", subtitle: "", byline: "", isPrivate: false, showSections: false }],
        insert: [],
        replaceContent: [{ storyId: "s1", steps: {}, layers: [], expected: "h" }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.refused.storyReplaceContent).toEqual([0]);
    const title = await env.DB.prepare("SELECT title FROM stories WHERE project_id = ? AND story_id = 's1'")
      .bind(fixture.projectId)
      .first<{ title: string }>();
    expect(title!.title).not.toBe("A new title on GitHub");
    expect(res.body.skipped.storyUpdate).toEqual(["s1"]);
  });
});

/** D1 refuses every INSERT into `table` whose row `when` matches, until dropped. */
async function failInserts(table: "steps" | "layers", when: string): Promise<() => Promise<void>> {
  const name = `inject_${table}_failure`;
  await env.DB.prepare(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'injected'); END`,
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  };
}

describe("stories.replaceContent is applied only once D1 shows it", () => {
  it("reports a story whose step INSERT failed as failed", async () => {
    const { fixture, storyId, expected } = await setup("rc-step-insert", [A, B]);
    const drop = await failInserts("steps", "NEW.question = 'C'");
    try {
      const res = await post(fixture, "/ingest-sync", "ingest-sync", replace("s1", incoming([A, B, C]), expected));
      expect(res.status).toBe(200);
      expect(res.body.content).toMatchObject({ applied: [], alreadyApplied: [], failed: ["s1"] });
      expect((await d1Rows(storyId)).steps.map((s) => s.question)).toEqual(["A", "B"]);
    } finally {
      await drop();
    }
  });

  it("reports a story whose layer INSERT failed as failed", async () => {
    const { fixture, expected } = await setup("rc-layer-insert", [A]);
    const drop = await failInserts("layers", "NEW.title = 'Injected'");
    try {
      const res = await post(fixture, "/ingest-sync", "ingest-sync",
        replace("s1", incoming([{ question: "A", layers: [{ title: "Injected", content: "Refused by D1." }] }]), expected));
      expect(res.status).toBe(200);
      expect(res.body.content).toMatchObject({ applied: [], alreadyApplied: [], failed: ["s1"] });
    } finally {
      await drop();
    }
  });

  it("reports a replay as failed while D1 still refuses the content", async () => {
    const { fixture, expected } = await setup("rc-replay-failing", [A, B]);
    const drop = await failInserts("steps", "NEW.question = 'C'");
    try {
      const payload = replace("s1", incoming([A, B, C]), expected);
      expect((await post(fixture, "/ingest-sync", "ingest-sync", payload)).body.content.failed).toEqual(["s1"]);
      const again = await post(fixture, "/ingest-sync", "ingest-sync", payload);
      expect(again.status).toBe(200);
      expect(again.body.content).toMatchObject({ applied: [], alreadyApplied: [], failed: ["s1"] });
    } finally {
      await drop();
    }
  });
});
