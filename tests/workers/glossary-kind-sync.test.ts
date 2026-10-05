/**
 * A glossary entry's kind through a sync, against the real Durable Object, the
 * real D1 and the real snapshot.
 *
 * The kind rides the document like the title does, so an accepted repo value
 * has to enter the document or the next snapshot writes the old one back over
 * it. A repo sheet that heads the column `tipo` is read as `kind`, and the
 * value stays out of the custom columns that the D1-only residue writes.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";

import { getDb } from "~/lib/db.server";
import { applyFullSyncChanges } from "~/lib/sync.server";
import { seedProject } from "./helpers/collaboration-client";

const OWNER = "harness";
const REPO = "glossary-kind";
const HEAD_SHA = "1".repeat(40);
const BEFORE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let glossaryCsv = "";

function stubKindRepo(): void {
  const contents: Record<string, () => string> = {
    "telar-content/spreadsheets/objects.csv": () => "",
    "telar-content/spreadsheets/project.csv": () => "order,story_id,title\n1,a-story,A story\n",
    "telar-content/spreadsheets/glossary.csv": () => glossaryCsv,
    "_config.yml": () => "title: Test\ntelar:\n  version: 1.8.0\n",
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/graphql")) {
      const body = String(init?.body ?? "");
      if (body.includes("SubtreeOids")) {
        const { variables } = JSON.parse(body) as { variables: Record<string, string> };
        const repository = Object.fromEntries(
          Object.keys(variables)
            .filter((key) => /^c\d+(p\d+)?$/.test(key))
            .map((key) => [key, key.includes("p") ? null : { __typename: "Commit" }]),
        );
        return Response.json({ data: { repository } });
      }
      if (body.includes("oid")) {
        return Response.json({ data: { repository: { ref: { target: { oid: HEAD_SHA } } } } });
      }
      return Response.json({ data: {} });
    }
    if (url.includes("/git/trees/")) return Response.json({ tree: [], truncated: false });
    const match = url.match(/\/contents\/(.+?)(\?|$)/);
    if (match) {
      const body = contents[decodeURIComponent(match[1])]?.();
      if (body === undefined) return new Response("not found", { status: 404 });
      const bytes = new TextEncoder().encode(body);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return Response.json({ content: btoa(binary), encoding: "base64", size: bytes.length });
    }
    return new Response("unexpected fetch", { status: 500 });
  });
}

const kindChanges = (projectId: number, glossary: { accept: string[]; insertNew: string[] }) => ({
  projectId,
  baseSha: BEFORE,
  storyContentChecked: true,
  pageContentChecked: true,
  objects: {
    newObjectIds: [], changedObjectIds: [], fieldChoices: {},
    removedObjectIds: [], unregisteredObjectIds: [],
  },
  stories: { accept: [], reject: [], insertNew: [] },
  config: { accept: [], reject: [] },
  // Each accepted term takes GitHub's kind, the one field this test moves.
  glossary: {
    reject: [],
    fieldChoices: Object.fromEntries(glossary.accept.map((id) => [id, { kind: "repo" as const }])),
    ...glossary,
  },
});

const kindSyncEnv = () => ({ SESSION_SECRET: env.SESSION_SECRET, COLLABORATION: env.COLLABORATION });

const kindRowOf = (projectId: number) =>
  env.DB.prepare("SELECT kind, extra_columns FROM glossary_terms WHERE project_id = ? AND term_id = 'carta'")
    .bind(projectId)
    .first<{ kind: string | null; extra_columns: string | null }>();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a glossary entry's kind through a sync", () => {
  it("reads a `tipo` column into the kind, then takes a changed value over the document", async () => {
    stubKindRepo();
    const { projectId, userId } = await seedProject("glossary-kind");
    await env.DB.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").bind(BEFORE, projectId).run();
    const applyKindChange = (c: ReturnType<typeof kindChanges>) =>
      applyFullSyncChanges(projectId, c, "tok", OWNER, REPO, getDb(env.DB), userId, kindSyncEnv());

    glossaryCsv = "term_id,title,definition,tipo\ncarta,Carta,Una carta,Fuente\n";
    await applyKindChange(kindChanges(projectId, { accept: [], insertNew: ["carta"] }));
    expect(await kindRowOf(projectId)).toEqual({ kind: "Fuente", extra_columns: null });

    glossaryCsv = "term_id,title,definition,tipo\ncarta,Carta,Una carta,place\n";
    await env.DB.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").bind(BEFORE, projectId).run();
    await applyKindChange(kindChanges(projectId, { accept: ["carta"], insertNew: [] }));
    expect(await kindRowOf(projectId)).toEqual({ kind: "place", extra_columns: null });
  });
});
