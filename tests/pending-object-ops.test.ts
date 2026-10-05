/**
 * The record of an objects operation whose commit may hold objects D1 lacks,
 * and the completion that finishes it.
 *
 * One row per operation, in D1 because the failure it has to outlive is most
 * often the collaboration object being unreachable. A row is completed by
 * sending its document half to `/ingest-sync` with the row's id as the
 * operation id; a prepared row, whose commit may or may not have landed, is
 * completed only when the sheet read at the caller's head is evidence that it
 * did, and dropped once it is older than the longest a lease is held.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import {
  PREPARED_OP_HOLD_MS,
  completePendingObjectOps,
  deletePendingObjectOp,
  markPendingObjectOpCommitted,
  parseSheetObjectIds,
  preparePendingObjectOp,
  readPendingObjectOp,
  sheetObjectIds,
  type SheetObjectIds,
} from "~/lib/pending-object-ops.server";
import { removeObjectRecord } from "~/lib/csv-record-scan.server";
import { unlinkProjectCascade } from "~/lib/project-unlink.server";
import { deleteProjectCascade } from "~/lib/import.server";
import type { PendingObject } from "~/lib/sync.server";

const PROJECT_ID = 1;
const SECRET = "test-session-secret";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)",
  );
});

afterEach(() => {
  memory.close();
});

function pending(objectId: string): PendingObject {
  return {
    object_id: objectId,
    title: `Title ${objectId}`,
    featured: false,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: `Alt ${objectId}`,
    image_available: false,
  };
}

function rows(): Array<Record<string, unknown>> {
  return memory.raw.prepare("SELECT * FROM pending_object_ops ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

interface IngestCall {
  body: Record<string, unknown>;
}

/** A collaboration binding that records each ingest and answers from `answer`. */
function makeEnv(answer: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: IngestCall[] = [];
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          const body = JSON.parse(await req.text()) as Record<string, unknown>;
          calls.push({ body });
          return answer(body);
        },
      }),
    },
  } as unknown as Env;
  return { env, calls };
}

const okInsert = () =>
  Response.json({ applied: { objectInsert: 1 }, skipped: {}, failed: {}, refused: {} });

const okRemove = (outcome: "applied" | "absent" | "superseded" | "course" = "applied") => (
  body: Record<string, unknown>,
) => {
  const removes = (body.objects as { remove: Array<{ objectId: string }> }).remove;
  const removals = { applied: [] as string[], absent: [] as string[], superseded: [] as string[], course: [] as string[] };
  for (const r of removes) removals[outcome].push(r.objectId);
  return Response.json({ applied: { objectRemove: outcome === "applied" ? removes.length : 0 }, skipped: {}, failed: {}, refused: {}, removals });
};

const NOW = new Date("2026-09-26T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

// ---------------------------------------------------------------------------
// The table and the cascades
// ---------------------------------------------------------------------------

describe("migration 0060 and the project cascades", () => {
  it("creates pending_object_ops with its checks", () => {
    memory.raw.exec(
      "INSERT INTO pending_object_ops (project_id, kind, state, payload, created_at) VALUES (1, 'register', 'prepared', '[]', 'x')",
    );
    expect(rows()).toHaveLength(1);
    expect(() =>
      memory.raw.exec(
        "INSERT INTO pending_object_ops (project_id, kind, state, payload, created_at) VALUES (1, 'purge', 'prepared', '[]', 'x')",
      ),
    ).toThrow();
    expect(() =>
      memory.raw.exec(
        "INSERT INTO pending_object_ops (project_id, kind, state, payload, created_at) VALUES (1, 'register', 'done', '[]', 'x')",
      ),
    ).toThrow();
  });

  // The foreign key cascades on its own in SQLite; the hand-listed cascades
  // name the table anyway, as they name every other, so neither depends on a
  // pragma. Recorded by table name, because the end state cannot tell the two
  // apart.
  it.each([
    ["unlinkProjectCascade", unlinkProjectCascade],
    ["deleteProjectCascade", deleteProjectCascade],
  ])("%s names the table before the projects row", async (_name, cascade) => {
    const visited: string[] = [];
    const nameOf = (table: unknown) =>
      String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);
    const fake = {
      insert: () => ({ select: () => ({}) }),
      delete: (table: unknown) => {
        visited.push(nameOf(table));
        return { where: () => Object.assign(Promise.resolve(undefined), { returning: async () => [] }) };
      },
      select: () => ({ from: () => ({ where: async () => [{ id: 1 }] }) }),
      batch: async () => [[]],
    };
    await cascade(fake, PROJECT_ID);
    expect(visited).toContain("pending_object_ops");
    expect(visited.indexOf("pending_object_ops")).toBeLessThan(visited.lastIndexOf("projects"));
  });

  it.each([
    ["unlinkProjectCascade", unlinkProjectCascade],
    ["deleteProjectCascade", deleteProjectCascade],
  ])("%s removes the project's rows", async (_name, cascade) => {
    await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pending("bell")], parentSha: "h", actorId: 1,
    });
    await cascade(db, PROJECT_ID);
    expect(rows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The row's lifecycle
// ---------------------------------------------------------------------------

describe("a row's lifecycle", () => {
  it("is written prepared on its head, marked committed with its commit, and deleted", async () => {
    const id = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pending("bell")], parentSha: "head-1", actorId: 1, now: NOW,
    });
    expect(rows()).toEqual([
      expect.objectContaining({
        id, project_id: 1, kind: "register", state: "prepared", parent_sha: "head-1", commit_sha: null,
        actor_id: 1, created_at: NOW.toISOString(),
      }),
    ]);
    expect(JSON.parse(String(rows()[0].payload))).toEqual([pending("bell")]);

    await markPendingObjectOpCommitted(db, id, "commit-1");
    expect(rows()[0]).toMatchObject({ state: "committed", commit_sha: "commit-1" });

    expect(await readPendingObjectOp(db, PROJECT_ID, id)).toMatchObject({ id, state: "committed" });
    expect(await readPendingObjectOp(db, PROJECT_ID + 1, id)).toBeNull();

    await deletePendingObjectOp(db, id);
    expect(rows()).toHaveLength(0);
  });

  it("never reuses an id", async () => {
    const a = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pending("a")], parentSha: "h", actorId: 1,
    });
    await deletePendingObjectOp(db, a);
    const b = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pending("b")], parentSha: "h", actorId: 1,
    });
    expect(b).toBeGreaterThan(a);
  });
});

// ---------------------------------------------------------------------------
// Reading the sheet
// ---------------------------------------------------------------------------

describe("the sheet as evidence", () => {
  it("reads the object ids under the canonical mapping, a Spanish header included", () => {
    expect(parseSheetObjectIds("object_id,title\nbell,Bell\ndrum,Drum\n")).toEqual({
      kind: "ids", ids: new Set(["bell", "drum"]),
    });
    expect(parseSheetObjectIds("﻿id_objeto,titulo\ncampana,Campana\n")).toEqual({
      kind: "ids", ids: new Set(["campana"]),
    });
  });

  it("skips comment rows as the importer does", () => {
    const sheet = "object_id,title\n# a note,\nbell,Bell\n";
    expect(parseSheetObjectIds(sheet)).toEqual({ kind: "ids", ids: new Set(["bell"]) });
  });

  it("is unusable without an identity column Telar recognises", () => {
    expect(parseSheetObjectIds("name,title\nbell,Bell\n")).toEqual({ kind: "unusable" });
  });

  it("is unusable when the file cannot be read cleanly", () => {
    expect(parseSheetObjectIds('object_id,title\n"bell,Bell\n')).toEqual({ kind: "unusable" });
    expect(parseSheetObjectIds("")).toEqual({ kind: "unusable" });
  });

  it("tells a missing file from a failed read", () => {
    expect(sheetObjectIds({ status: "absent" })).toEqual({ kind: "absent" });
    expect(sheetObjectIds({ status: "error" })).toBeNull();
    expect(sheetObjectIds({ status: "ok", content: "object_id\nbell\n" })).toEqual({
      kind: "ids", ids: new Set(["bell"]),
    });
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

const ids = (...list: string[]): SheetObjectIds => ({ kind: "ids", ids: new Set(list) });

async function registerRow(
  objectIds: string[],
  state: "prepared" | "committed",
  createdAt: Date = minutesAgo(5),
): Promise<number> {
  const id = await preparePendingObjectOp(db, {
    projectId: PROJECT_ID, kind: "register", objects: objectIds.map(pending), parentSha: "h", actorId: 1, now: createdAt,
  });
  if (state === "committed") await markPendingObjectOpCommitted(db, id, "c");
  return id;
}

async function removeRow(
  targets: Array<{ object_id: string; doc_id: number }>,
  state: "prepared" | "committed",
  createdAt: Date = minutesAgo(5),
): Promise<number> {
  const id = await preparePendingObjectOp(db, {
    projectId: PROJECT_ID, kind: "remove", targets, parentSha: "h", actorId: 1, now: createdAt,
  });
  if (state === "committed") await markPendingObjectOpCommitted(db, id, "c");
  return id;
}

describe("completePendingObjectOps", () => {
  it("reads no sheet and wakes nothing when there are no rows", async () => {
    const { env, calls } = makeEnv(okInsert);
    let sheetReads = 0;
    const result = await completePendingObjectOps(env, db, PROJECT_ID, async () => {
      sheetReads += 1;
      return ids();
    });
    expect(result.ok).toBe(true);
    expect(sheetReads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("register, committed: ingests it with its operation id and deletes the row", async () => {
    const id = await registerRow(["bell"], "committed");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
    expect(result).toMatchObject({ ok: true });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.opId).toBe(id);
    const inserts = (calls[0].body.objects as { insert: Array<{ object_id: string; created_by: number }> }).insert;
    expect(inserts.map((i) => i.object_id)).toEqual(["bell"]);
    expect(inserts[0].created_by).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  it("register, committed: needs no sheet", async () => {
    await registerRow(["bell"], "committed");
    const { env } = makeEnv(okInsert);
    let sheetReads = 0;
    const result = await completePendingObjectOps(env, db, PROJECT_ID, async () => {
      sheetReads += 1;
      return null;
    }, { now: NOW });
    expect(result.ok).toBe(true);
    expect(sheetReads).toBe(0);
  });

  it("an answer of already applied completes the row", async () => {
    await registerRow(["bell"], "committed");
    const { env } = makeEnv(() => Response.json({ alreadyApplied: true }));
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
    expect(result.ok).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it("register, prepared, in the sheet: ingests it (IIIF and external objects need only the sheet)", async () => {
    const id = await registerRow(["bell", "manifest-object"], "prepared");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("bell", "manifest-object", "other"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.opId).toBe(id);
    expect(rows()).toHaveLength(0);
  });

  it("register, prepared, not in the sheet: kept inside the hour, dropped after it", async () => {
    const young = await registerRow(["bell"], "prepared", minutesAgo(59));
    const old = await registerRow(["drum"], "prepared", new Date(NOW.getTime() - PREPARED_OP_HOLD_MS - 1));
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("other"), { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.outcomes.get(young)).toBe("kept");
    expect(result.outcomes.get(old)).toBe("dropped");
    expect(calls).toHaveLength(0);
    expect(rows().map((r) => r.id)).toEqual([young]);
  });

  // B4: the objects that landed are registered now, so a CSV rewritten from
  // D1 after this keeps them; the one that did not is held for the hour.
  it("register, prepared, only some of its objects in the sheet: registers those, holds the rest", async () => {
    const id = await registerRow(["bell", "drum"], "prepared");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("bell"), { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.outcomes.get(id)).toBe("kept");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.opId).toBe(id);
    const sent = (calls[0].body.objects as { insert: Array<{ object_id: string }> }).insert;
    expect(sent.map((i) => i.object_id)).toEqual(["bell"]);
    expect(rows().map((r) => r.id)).toEqual([id]);
  });

  it("register, prepared, some in the sheet after the hour: registers those and drops the rest", async () => {
    const id = await registerRow(["bell", "drum"], "prepared", new Date(NOW.getTime() - PREPARED_OP_HOLD_MS - 1));
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("bell"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("completed");
    const sent = (calls[0].body.objects as { insert: Array<{ object_id: string }> }).insert;
    expect(sent.map((i) => i.object_id)).toEqual(["bell"]);
    expect(rows()).toHaveLength(0);
  });

  it("register, prepared, some in the sheet: a failed registration of those stops completion", async () => {
    const id = await registerRow(["bell", "drum"], "prepared");
    const { env } = makeEnv(() => new Response("x", { status: 503 }));
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("bell"), { now: NOW });
    expect(result).toMatchObject({ ok: false, failedOp: id });
  });

  it("remove, prepared, only some of its objects gone from the sheet: removes those, holds the rest", async () => {
    const id = await removeRow([{ object_id: "bell", doc_id: 1 }, { object_id: "drum", doc_id: 2 }], "prepared");
    const { env, calls } = makeEnv(okRemove());
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("drum"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("kept");
    expect(calls[0].body).toMatchObject({ opId: id, objects: { remove: [{ objectId: "bell", docId: 1 }] } });
    expect(rows().map((r) => r.id)).toEqual([id]);
  });

  it("register, prepared, no sheet at all: not in it", async () => {
    const id = await registerRow(["bell"], "prepared");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, { kind: "absent" }, { now: NOW });
    expect(result.outcomes.get(id)).toBe("kept");
    expect(calls).toHaveLength(0);
  });

  it("remove, committed: ingests the removal with the object's D1 id", async () => {
    const id = await removeRow([{ object_id: "bell", doc_id: 17 }], "committed");
    const { env, calls } = makeEnv(okRemove());
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("bell"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls[0].body).toMatchObject({ opId: id, objects: { remove: [{ objectId: "bell", docId: 17 }] } });
    expect(rows()).toHaveLength(0);
  });

  it("remove, prepared, absent from the sheet: ingests the removal", async () => {
    const id = await removeRow([{ object_id: "bell", doc_id: 17 }], "prepared");
    const { env, calls } = makeEnv(okRemove());
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("drum"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls).toHaveLength(1);
  });

  it("remove, prepared, no sheet at all: absent from it", async () => {
    const id = await removeRow([{ object_id: "bell", doc_id: 17 }], "prepared");
    const { env, calls } = makeEnv(okRemove());
    const result = await completePendingObjectOps(env, db, PROJECT_ID, { kind: "absent" }, { now: NOW });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls).toHaveLength(1);
  });

  it("remove, prepared, still in the sheet: kept inside the hour, dropped after it", async () => {
    const young = await removeRow([{ object_id: "bell", doc_id: 17 }], "prepared", minutesAgo(30));
    const old = await removeRow([{ object_id: "drum", doc_id: 18 }], "prepared", new Date(NOW.getTime() - PREPARED_OP_HOLD_MS - 1));
    const { env, calls } = makeEnv(okRemove());
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids("bell", "drum"), { now: NOW });
    expect(result.outcomes.get(young)).toBe("kept");
    expect(result.outcomes.get(old)).toBe("dropped");
    expect(calls).toHaveLength(0);
    expect(rows().map((r) => r.id)).toEqual([young]);
  });

  // The evidence is the id's absence from the sheet at the committed head. A
  // removal that left a later row carrying the id would read as not landed.
  it("remove, prepared, an id in two rows: held against the captured sheet, completed against the committed one", async () => {
    const captured = "object_id,title\nbell,Bell\ndrum,Drum\nbell,Bell again\n";
    const removal = removeObjectRecord(captured, "bell");
    expect(removal.status).toBe("removed");
    const committed = removal.status === "removed" ? removal.text : "";
    expect(parseSheetObjectIds(committed)).toEqual(ids("drum"));

    const id = await removeRow([{ object_id: "bell", doc_id: 17 }], "prepared");
    const { env, calls } = makeEnv(okRemove());
    const held = await completePendingObjectOps(env, db, PROJECT_ID, parseSheetObjectIds(captured), { now: NOW });
    expect(held.outcomes.get(id)).toBe("kept");
    expect(calls).toHaveLength(0);

    const done = await completePendingObjectOps(env, db, PROJECT_ID, parseSheetObjectIds(committed), { now: NOW });
    expect(done.outcomes.get(id)).toBe("completed");
    expect(calls[0].body).toMatchObject({ opId: id, objects: { remove: [{ objectId: "bell", docId: 17 }] } });
    expect(rows()).toHaveLength(0);
  });

  it.each(["superseded", "course", "absent"] as const)(
    "a removal answered %s drops the operation",
    async (outcome) => {
      await removeRow([{ object_id: "bell", doc_id: 17 }], "committed");
      const { env } = makeEnv(okRemove(outcome));
      const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
      expect(result.ok).toBe(true);
      expect(rows()).toHaveLength(0);
    },
  );

  // A sheet whose ids cannot be read is no evidence either way, and the
  // caller must not go on to rewrite it.
  it("an unusable sheet fails completion at the first row that needs it", async () => {
    const committed = await registerRow(["flute"], "committed");
    const prepared = await registerRow(["bell"], "prepared", minutesAgo(59));
    const preparedRemove = await removeRow([{ object_id: "drum", doc_id: 3 }], "prepared");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, { kind: "unusable" }, { now: NOW });
    expect(result).toMatchObject({ ok: false, failedOp: prepared });
    expect(result.outcomes.get(committed)).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(rows().map((r) => r.id)).toEqual([prepared, preparedRemove]);
  });

  // The hour bound holds whatever the sheet: the remedy for an unusable sheet
  // is on GitHub, so a refusal that never ends would be one nothing here can
  // lift.
  it.each<[string, () => Promise<SheetObjectIds | null>]>([
    ["unusable", async () => ({ kind: "unusable" })],
    ["unreadable", async () => null],
  ])("an %s sheet drops a prepared row past the hour, and completes the rest", async (_name, sheet) => {
    const oldRegister = await registerRow(["bell"], "prepared", new Date(NOW.getTime() - PREPARED_OP_HOLD_MS - 1));
    const oldRemove = await removeRow([{ object_id: "drum", doc_id: 3 }], "prepared", new Date(NOW.getTime() - PREPARED_OP_HOLD_MS - 1));
    const committed = await registerRow(["flute"], "committed");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheet, { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.outcomes.get(oldRegister)).toBe("dropped");
    expect(result.outcomes.get(oldRemove)).toBe("dropped");
    expect(result.outcomes.get(committed)).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(rows()).toHaveLength(0);
  });

  it.each<[string, () => Promise<SheetObjectIds | null>]>([
    ["unusable", async () => ({ kind: "unusable" })],
    ["unreadable", async () => null],
  ])("an %s sheet still fails completion for a prepared row inside the hour", async (_name, sheet) => {
    const young = await registerRow(["bell"], "prepared", minutesAgo(59));
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheet, { now: NOW });
    expect(result).toMatchObject({ ok: false, failedOp: young });
    expect(calls).toHaveLength(0);
    expect(rows().map((r) => r.id)).toEqual([young]);
  });

  it("a sheet that cannot be read holds the prepared rows and fails the completion", async () => {
    const prepared = await registerRow(["bell"], "prepared");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, async () => null, { now: NOW });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(rows().map((r) => r.id)).toEqual([prepared]);
  });

  it("stops at a failed ingest and leaves it and every later row", async () => {
    const first = await registerRow(["bell"], "committed");
    const second = await registerRow(["drum"], "committed");
    const third = await registerRow(["flute"], "committed");
    let n = 0;
    const { env, calls } = makeEnv(() => {
      n += 1;
      return n === 2 ? new Response("snapshot_failed", { status: 503 }) : okInsert();
    });
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
    expect(result).toMatchObject({ ok: false, failedOp: second });
    expect(calls).toHaveLength(2);
    expect(rows().map((r) => r.id)).toEqual([second, third]);
    expect(first).toBeLessThan(second);
  });

  it("treats an unreachable collaboration object as a failed ingest", async () => {
    await removeRow([{ object_id: "bell", doc_id: 17 }], "committed");
    const { env } = makeEnv(() => {
      throw new Error("Durable Object reset because its code was updated.");
    });
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
    expect(result.ok).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it("keeps a registration D1 refused, so it is tried again", async () => {
    await registerRow(["bell"], "committed");
    const { env } = makeEnv(() =>
      Response.json({ applied: { objectInsert: 1 }, skipped: {}, failed: { objectInsert: ["bell"] }, refused: {} }),
    );
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
    expect(result.ok).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  // After a commit has landed, a refusal no retry changes can only mean the
  // action's validation and the ingest's disagree: a bug, kept loud.
  it("keeps a row whose registration the ingest refused, and fails", async () => {
    await registerRow(["bell"], "committed");
    const { env } = makeEnv(() => Response.json({ applied: {}, refused: { objectInsert: [0] } }));
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
    expect(result.ok).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it("completes in id order", async () => {
    await registerRow(["a"], "committed");
    await registerRow(["b"], "committed");
    await registerRow(["c"], "committed");
    const { env, calls } = makeEnv(okInsert);
    await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW });
    const order = calls.map((c) => (c.body.objects as { insert: Array<{ object_id: string }> }).insert[0].object_id);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("completes only the named operations when asked, and no other project's", async () => {
    const mine = await registerRow(["a"], "committed");
    const other = await registerRow(["b"], "committed");
    memory.raw.exec(
      "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (2, 1, 'o/b', 1)",
    );
    const foreign = await preparePendingObjectOp(db, {
      projectId: 2, kind: "register", objects: [pending("z")], parentSha: "h", actorId: 1,
    });
    await markPendingObjectOpCommitted(db, foreign, "c");
    const { env, calls } = makeEnv(okInsert);
    const result = await completePendingObjectOps(env, db, PROJECT_ID, ids(), { now: NOW, opIds: [mine, foreign] });
    expect(result.outcomes.get(mine)).toBe("completed");
    expect(result.outcomes.has(foreign)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(rows().map((r) => r.id)).toEqual([other, foreign]);
  });
});
