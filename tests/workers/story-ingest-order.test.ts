/**
 * An ingest that inserts a new story keeps the payload's order for its steps
 * and layers, in the document and in D1 after a snapshot.
 *
 * `buildStoryYMap` mints each entry's `order_key` while its Y.Array is still
 * detached from the document — appending to the array is not the same as the
 * array being readable — so a reader has to see the payload order survive a
 * sort by `order_key`, not merely arrive in that position by construction.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { signInternalMarker } from "../../workers/auth";
import { orderedMaps } from "~/lib/field-order";
import {
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

/** A signed internal request, with its body read so the object can be evicted. */
async function post(fixture: Fixture, path: string, action: string, body?: unknown): Promise<number> {
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
  await response.text();
  return response.status;
}

const snapshot = (fixture: Fixture) => post(fixture, "/snapshot", "snapshot");

async function storyDbId(fixture: Fixture): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM stories WHERE project_id = ? AND story_id = 's1'")
    .bind(fixture.projectId)
    .first<{ id: number }>();
  return row!.id;
}

function textOf(value: unknown): string {
  return value instanceof Y.Text ? value.toString() : String(value ?? "");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 30 distinct questions, "q01".."q30", one per step, in payload order. */
const QUESTIONS = Array.from({ length: 30 }, (_, i) => `q${pad(i + 1)}`);

/** 3 layers on the 5th step (index 4), 2 on the 20th (index 19), each with a
 *  distinct title, listed in the order the payload sends them. */
const LAYERS_ON_STEP_5 = ["Layer 5-1", "Layer 5-2", "Layer 5-3"];
const LAYERS_ON_STEP_20 = ["Layer 20-1", "Layer 20-2"];

function ingestPayload(fixture: Fixture) {
  return {
    stories: {
      update: [],
      insert: [{
        storyId: "s1",
        title: fixture.storyTitle,
        steps: QUESTIONS.map((question, i) => ({
          step_number: i + 1,
          kind: "media",
          object_id: "obj",
          question,
        })),
        layers: [
          ...LAYERS_ON_STEP_5.map((title, i) => ({
            step_index: 4,
            layer_number: i + 1,
            title,
          })),
          ...LAYERS_ON_STEP_20.map((title, i) => ({
            step_index: 19,
            layer_number: i + 1,
            title,
          })),
        ],
      }],
    },
  };
}

/** The document's story-s1 steps sorted by order_key, plus, for any step that
 *  carries layers, its layers sorted by order_key. */
async function docOrder(fixture: Fixture): Promise<{
  questions: string[];
  layerTitlesByQuestion: Record<string, string[]>;
}> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray()
      .find((m) => m.get("story_id") === "s1");
    if (!story) throw new Error("no story s1 in the document");
    const steps = orderedMaps(story.get("steps"));
    const questions = steps.map((s) => textOf(s.get("question")));
    const layerTitlesByQuestion: Record<string, string[]> = {};
    for (const step of steps) {
      const layers = orderedMaps(step.get("layers"));
      if (layers.length === 0) continue;
      layerTitlesByQuestion[textOf(step.get("question"))] = layers.map((l) => textOf(l.get("title")));
    }
    return { questions, layerTitlesByQuestion };
  });
}

/** The story's D1 steps ordered by order_key, id alongside question. */
async function d1StepsInOrder(fixture: Fixture): Promise<Array<{ id: number; question: string }>> {
  const rows = await env.DB.prepare(
    "SELECT id, question FROM steps WHERE story_id = ? ORDER BY order_key ASC",
  )
    .bind(await storyDbId(fixture))
    .all<{ id: number; question: string }>();
  return rows.results;
}

/** A D1 step's layer titles, ordered by order_key. */
async function d1LayerTitles(stepId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT title FROM layers WHERE step_id = ? ORDER BY order_key ASC",
  )
    .bind(stepId)
    .all<{ title: string }>();
  return rows.results.map((r) => r.title);
}

describe("an ingested story's steps and layers", () => {
  it("read in payload order, in the document and in D1 after a snapshot", async () => {
    const fixture = await seedProject("story-ingest-order");
    touched.add(stubFor(fixture.projectId));

    const status = await post(fixture, "/ingest-sync", "ingest-sync", ingestPayload(fixture));
    expect(status).toBe(200);

    const { questions, layerTitlesByQuestion } = await docOrder(fixture);
    expect(questions).toEqual(QUESTIONS);
    expect(layerTitlesByQuestion["q05"]).toEqual(LAYERS_ON_STEP_5);
    expect(layerTitlesByQuestion["q20"]).toEqual(LAYERS_ON_STEP_20);

    expect(await snapshot(fixture)).toBe(200);

    const d1Steps = await d1StepsInOrder(fixture);
    expect(d1Steps.map((s) => s.question)).toEqual(QUESTIONS);

    const step5 = d1Steps.find((s) => s.question === "q05")!;
    const step20 = d1Steps.find((s) => s.question === "q20")!;
    expect(await d1LayerTitles(step5.id)).toEqual(LAYERS_ON_STEP_5);
    expect(await d1LayerTitles(step20.id)).toEqual(LAYERS_ON_STEP_20);
  });
});
