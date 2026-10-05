/**
 * The failed-apply / retry cycle for the glossary residue, against the real
 * Durable Object, the real D1 and the real snapshot.
 *
 * `applyFullSyncChanges` writes an inserted term's D1-only columns AFTER the
 * ingest, because the row does not exist before it, and that write must still
 * land before head_sha advances: a head that moved with the column missing
 * becomes the base of the next three-way diff, which reads the absence as an
 * editor-only change and suppresses it. The unit suite proves the rejection
 * propagates through doubles; this proves the cycle actually recovers — the DO
 * really inserts the term, the second attempt really gets `skipped` back from
 * it, and the residue really completes the row.
 *
 * Two things are stubbed, and only two. Outbound `fetch` is stubbed because the
 * repo files would otherwise come from api.github.com. The D1 binding is
 * wrapped for the first attempt alone, so that one UPDATE against
 * `glossary_terms` rejects the way a D1 error would; everything else — the
 * ingest, the document, the snapshot, every other statement — runs for real
 * against the migrated database.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";

import { getDb } from "~/lib/db.server";
import { applyFullSyncChanges } from "~/lib/sync.server";
import { seedProject } from "./helpers/collaboration-client";

const OWNER = "harness";
const REPO = "glossary-residue";
const HEAD_SHA = "0".repeat(40);
const EXTRAS = JSON.stringify({ source_note: "Museo del Oro" });

const GLOSSARY_CSV =
  "term_id,title,definition,related_terms,source_note\n" +
  'new-term,"New term","A definition",,Museo del Oro\n';

/** The repo as GitHub would answer for it. */
function stubGitHub(): void {
  const contents: Record<string, string> = {
    "telar-content/spreadsheets/objects.csv": "",
    "telar-content/spreadsheets/project.csv": "order,story_id,title\n1,a-story,A story\n",
    "telar-content/spreadsheets/glossary.csv": GLOSSARY_CSV,
    "_config.yml": "title: Test\ntelar:\n  version: 1.7.0\n",
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // getRepoHead and getRepoTree both go through the GraphQL endpoint.
    if (url.includes("/graphql")) {
      const body = String(init?.body ?? "");
      // The story subtrees and the pages folder (getSubtreeOids): every commit
      // resolves and no subtree exists, which the accept reads as concluded.
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
    if (url.includes("/git/trees/")) {
      return Response.json({ tree: [], truncated: false });
    }
    const match = url.match(/\/contents\/(.+?)(\?|$)/);
    if (match) {
      const path = decodeURIComponent(match[1]);
      const body = contents[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      // The API answers base64; getFileContent decodes it.
      const bytes = new TextEncoder().encode(body);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return Response.json({ content: btoa(binary), encoding: "base64", size: bytes.length });
    }
    return new Response("unexpected fetch", { status: 500 });
  });
}

/**
 * The D1 binding with one statement made to fail: any UPDATE naming
 * `extra_columns` on glossary_terms rejects. Every other statement is the real
 * binding's.
 *
 * The failure is raised from an async body rather than minted as an
 * already-rejected promise. D1 rejects after I/O, and drizzle's driver returns
 * the statement's promise out of an async wrapper, which adopts it a microtask
 * after creation; a promise rejected before that handler attaches is reported
 * as an unhandled rejection even though the apply observes it and throws.
 */
function dbWithFailingGlossaryUpdate(): D1Database {
  return new Proxy(env.DB, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        // Drizzle emits quoted, lower-case SQL: update "glossary_terms" set …
        const failing =
          /update/i.test(sql) && /glossary_terms/i.test(sql) && /extra_columns/i.test(sql);
        if (!failing) return stmt;
        return new Proxy(stmt, {
          get(s, p, r) {
            if (p !== "bind") return Reflect.get(s, p, r);
            const reject = async () => {
              await Promise.resolve();
              throw new Error("D1_ERROR: glossary_terms write failed");
            };
            return () => ({ run: reject, all: reject, first: reject });
          },
        });
      };
    },
  }) as D1Database;
}

/** The head_sha recorded before the apply: the base the check compared against. */
const BEFORE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const changes = (projectId: number) => ({
  // A check computed for this project against the recorded head.
  projectId,
  baseSha: BEFORE,
  // The check the dialog showed read the story and page files to a conclusion.
  storyContentChecked: true,
  pageContentChecked: true,
  objects: {
    newObjectIds: [], changedObjectIds: [], fieldChoices: {},
    removedObjectIds: [], unregisteredObjectIds: [],
  },
  stories: { accept: [], reject: [], insertNew: [] },
  config: { accept: [], reject: [] },
  glossary: { accept: [], reject: [], insertNew: ["new-term"] },
});

const syncEnv = () => ({
  SESSION_SECRET: env.SESSION_SECRET,
  COLLABORATION: env.COLLABORATION,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("glossary residue: a failed apply, then a retry that recovers", () => {
  it("holds head_sha back, then completes the row on the second attempt", async () => {
    stubGitHub();
    const { projectId, userId } = await seedProject("glossary-residue");
    await env.DB.prepare("UPDATE projects SET head_sha = ? WHERE id = ?")
      .bind(BEFORE, projectId)
      .run();

    // --- first attempt: the DO inserts the term, the residue write fails -----
    await expect(
      applyFullSyncChanges(
        projectId, changes(projectId), "tok", OWNER, REPO,
        getDb(dbWithFailingGlossaryUpdate()), userId, syncEnv(),
      ),
      // Drizzle wraps a driver error, so the match is on the statement it names.
    ).rejects.toThrow(/glossary_terms/);

    const afterFailure = await env.DB
      .prepare("SELECT head_sha FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ head_sha: string | null }>();
    expect(afterFailure?.head_sha, "head_sha advanced despite the failed write").toBe(BEFORE);

    // The DO did insert the term — that is why the residue cannot move earlier.
    const inserted = await env.DB
      .prepare("SELECT term_id, extra_columns FROM glossary_terms WHERE project_id = ?")
      .bind(projectId)
      .all<{ term_id: string; extra_columns: string | null }>();
    expect(inserted.results.map((r) => r.term_id)).toContain("new-term");
    expect(inserted.results[0].extra_columns, "the residue is what was lost").toBeNull();

    // --- the retry: the term is already in the document, the residue lands ---
    const result = await applyFullSyncChanges(
      projectId, changes(projectId), "tok", OWNER, REPO, getDb(env.DB), userId, syncEnv(),
    );

    const recovered = await env.DB
      .prepare("SELECT term_id, extra_columns FROM glossary_terms WHERE project_id = ?")
      .bind(projectId)
      .all<{ term_id: string; extra_columns: string | null }>();
    expect(recovered.results).toHaveLength(1); // skip-if-present: no second row
    expect(recovered.results[0].extra_columns).toBe(EXTRAS);

    const afterRetry = await env.DB
      .prepare("SELECT head_sha FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ head_sha: string | null }>();
    expect(afterRetry?.head_sha).toBe(HEAD_SHA);
    expect(result.newHeadSha).toBe(HEAD_SHA);
  });
});
