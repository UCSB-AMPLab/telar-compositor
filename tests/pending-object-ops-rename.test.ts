/**
 * The `rename` record of an object's ID change and its completion.
 *
 * A rename's record names its object by the new id: a committed one is
 * applied through the collaboration object's `objects.rename` arm with the
 * record's id, and a prepared one only when objects.csv at the caller's head
 * holds the new id and not the old one. Anything else (the old id only, both,
 * neither, a sheet that cannot be read) is held for the hold and dropped
 * after it, as the other kinds are. A rename whose only commit switched Google
 * Sheets off (`sheets_off`) names an object the sheet has no row for, and is
 * judged by whether `_config.yml` at the head still reads Sheets.
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
  markPendingObjectOpCommitted,
  preparePendingObjectOp,
  type RenameTarget,
  type SheetObjectIds,
} from "~/lib/pending-object-ops.server";

const PROJECT_ID = 1;
const NOW = new Date("2026-10-03T12:00:00.000Z");
const renameMinutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
});

afterEach(() => {
  memory.close();
});

const MAP_RENAME: RenameTarget = {
  from: "map.jpg",
  to: "city-map",
  doc_id: 17,
  step_values: ["map.jpg", "map"],
  rules: { moved: [{ from: "map.jpg", to: "city-map.jpg" }], carouselShadowed: [], tiles: null, oldSiteId: "map" },
};

const sheetOf = (...list: string[]): SheetObjectIds => ({ kind: "ids", ids: new Set(list) });

function rowsLeft(): Array<Record<string, unknown>> {
  return memory.raw.prepare("SELECT * FROM pending_object_ops ORDER BY id").all() as Array<Record<string, unknown>>;
}

async function renameRow(state: "prepared" | "committed", createdAt: Date = renameMinutesAgo(5)): Promise<number> {
  const id = await preparePendingObjectOp(db, {
    projectId: PROJECT_ID, kind: "rename", rename: MAP_RENAME, parentSha: "h", actorId: 1, now: createdAt,
  });
  if (state === "committed") await markPendingObjectOpCommitted(db, id, "c");
  return id;
}

/** A collaboration binding that records each ingest and answers from `answer`. */
function renameEnv(answer: (body: Record<string, unknown>) => Response = () => renamedAnswer("applied")) {
  const calls: Array<Record<string, unknown>> = [];
  const env = {
    SESSION_SECRET: "test-session-secret",
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          const body = JSON.parse(await req.text()) as Record<string, unknown>;
          calls.push(body);
          return answer(body);
        },
      }),
    },
  } as unknown as Env;
  return { env, calls };
}

function renamedAnswer(kind: "applied" | "alreadyApplied" | "superseded" | "absent" | "course"): Response {
  const renames = { applied: [], alreadyApplied: [], superseded: [], absent: [], course: [], displaced: [] } as Record<string, unknown[]>;
  renames[kind] = ["city-map"];
  return Response.json({ renames, refused: { objectRename: [] }, receipted: { objectRename: [] } });
}

describe("a rename record", () => {
  it("is written with a one-element payload naming both ids, the row, the step values and the text", async () => {
    await renameRow("prepared");
    const [row] = rowsLeft();
    expect(row).toMatchObject({ kind: "rename", state: "prepared", parent_sha: "h" });
    expect(JSON.parse(String(row.payload))).toEqual([MAP_RENAME]);
  });
});

describe("completing a rename", () => {
  it("committed: sends the rename arm alone with the record's id, and deletes the record", async () => {
    const id = await renameRow("committed");
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("map.jpg"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls).toEqual([
      {
        opId: id,
        objects: {
          rename: [{ from: "map.jpg", to: "city-map", docId: 17, stepValues: ["map.jpg", "map"], rules: MAP_RENAME.rules }],
        },
      },
    ]);
    expect(rowsLeft()).toHaveLength(0);
  });

  it.each(["alreadyApplied", "superseded", "absent", "course"] as const)(
    "committed: an answer of %s finishes the operation",
    async (kind) => {
      await renameRow("committed");
      const { env } = renameEnv(() => renamedAnswer(kind));
      const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf(), { now: NOW });
      expect(result.ok).toBe(true);
      expect(rowsLeft()).toHaveLength(0);
    },
  );

  it("prepared, the sheet holding the new id and not the old: applied", async () => {
    const id = await renameRow("prepared");
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("city-map", "bell"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(rowsLeft()).toHaveLength(0);
  });

  it.each([
    ["the old id only", sheetOf("map.jpg")],
    ["both ids", sheetOf("map.jpg", "city-map")],
    ["neither id", sheetOf("bell")],
    ["no sheet", { kind: "absent" } as SheetObjectIds],
  ])("prepared, %s: kept inside the hold, sending nothing", async (_label, sheet) => {
    const id = await renameRow("prepared", renameMinutesAgo(30));
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheet, { now: NOW });
    expect(result.outcomes.get(id)).toBe("kept");
    expect(calls).toHaveLength(0);
    expect(rowsLeft()).toHaveLength(1);
  });

  it("prepared, both ids, past the hold: dropped, sending nothing", async () => {
    const id = await renameRow("prepared", new Date(NOW.getTime() - PREPARED_OP_HOLD_MS - 1));
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("map.jpg", "city-map"), { now: NOW });
    expect(result.outcomes.get(id)).toBe("dropped");
    expect(calls).toHaveLength(0);
    expect(rowsLeft()).toHaveLength(0);
  });

  it("prepared, a sheet that cannot be read: fails completion inside the hold", async () => {
    await renameRow("prepared");
    const { env } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, async () => null, { now: NOW });
    expect(result.ok).toBe(false);
    expect(rowsLeft()).toHaveLength(1);
  });

  it("keeps the record and fails when the arm answers 503", async () => {
    const id = await renameRow("committed");
    const { env } = renameEnv(() => new Response("snapshot_failed", { status: 503 }));
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf(), { now: NOW });
    expect(result).toMatchObject({ ok: false, failedOp: id });
    expect(rowsLeft()).toHaveLength(1);
  });

  it("keeps the record and fails when the arm refuses the entry", async () => {
    await renameRow("committed");
    const { env } = renameEnv(() => Response.json({ renames: {}, refused: { objectRename: [0] } }));
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf(), { now: NOW });
    expect(result.ok).toBe(false);
    expect(rowsLeft()).toHaveLength(1);
  });
});

describe("completing a rename whose only commit switched Sheets off", () => {
  const SHEETS_OFF_RENAME: RenameTarget = { ...MAP_RENAME, sheets_off: true };

  async function sheetsOffRow(createdAt: Date = renameMinutesAgo(5)): Promise<number> {
    return preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "rename", rename: SHEETS_OFF_RENAME, parentSha: "h", actorId: 1, now: createdAt,
    });
  }

  it("prepared, Sheets off at the head: applied, though the sheet has neither id", async () => {
    const id = await sheetsOffRow();
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, sheetsOn: async () => false });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls.filter((call) => call.objects !== undefined)).toHaveLength(1);
    expect(rowsLeft()).toHaveLength(0);
  });

  it("prepared, Sheets off at the head: repairs the stored configuration before the rename, as a landed commit's answer does", async () => {
    memory.raw.exec(`INSERT INTO project_config (project_id, google_sheets_enabled) VALUES (${PROJECT_ID}, 1)`);
    await sheetsOffRow();
    const { env, calls } = renameEnv();
    await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, sheetsOn: async () => false });
    expect(calls.map((call) => Object.keys(call).sort().join(","))).toEqual(["config", "objects,opId"]);
    expect(calls[0]).toEqual({ config: [{ key: "google_sheets_enabled", value: false }] });
    // The document's answer is not a config one, so the repair writes D1 directly.
    expect(memory.raw.prepare("SELECT google_sheets_enabled FROM project_config").get()).toEqual({ google_sheets_enabled: 0 });
  });

  it("prepared, Sheets still on at the head: kept inside the hold, sending nothing", async () => {
    const id = await sheetsOffRow(renameMinutesAgo(30));
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, sheetsOn: async () => true });
    expect(result.outcomes.get(id)).toBe("kept");
    expect(calls).toHaveLength(0);
    expect(rowsLeft()).toHaveLength(1);
  });

  it("prepared, Sheets still on past the hold: dropped, sending nothing", async () => {
    const id = await sheetsOffRow(new Date(NOW.getTime() - PREPARED_OP_HOLD_MS - 1));
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, sheetsOn: async () => true });
    expect(result.outcomes.get(id)).toBe("dropped");
    expect(calls).toHaveLength(0);
    expect(rowsLeft()).toHaveLength(0);
  });

  it("prepared, the sheet holding the new id and not the old but Sheets still on: kept", async () => {
    const id = await sheetsOffRow();
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("city-map"), { now: NOW, sheetsOn: async () => true });
    expect(result.outcomes.get(id)).toBe("kept");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a _config.yml that cannot be read", { sheetsOn: async () => null }],
    ["no reading of _config.yml", {}],
  ])("prepared, %s: fails completion inside the hold", async (_label, reading) => {
    await sheetsOffRow();
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, ...reading });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(rowsLeft()).toHaveLength(1);
  });

  it("committed: applied without reading _config.yml", async () => {
    const id = await sheetsOffRow();
    await markPendingObjectOpCommitted(db, id, "c");
    const { env, calls } = renameEnv();
    let read = false;
    const sheetsOn = async () => {
      read = true;
      return true;
    };
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf(), { now: NOW, sheetsOn });
    expect(result.outcomes.get(id)).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(read).toBe(false);
  });
});

describe("completing a Sheets-off rename that a newer one from the same id supersedes", () => {
  const SHEETS_OFF_RENAME: RenameTarget = { ...MAP_RENAME, sheets_off: true };

  async function sheetsOffRow(rename: Partial<RenameTarget> = {}, state: "prepared" | "committed" = "prepared"): Promise<number> {
    const id = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "rename", rename: { ...SHEETS_OFF_RENAME, ...rename }, parentSha: "h", actorId: 1, now: renameMinutesAgo(5),
    });
    if (state === "committed") await markPendingObjectOpCommitted(db, id, "c");
    return id;
  }

  const sentTo = (calls: Array<Record<string, unknown>>) =>
    calls.flatMap((call) => ((call.objects as { rename?: Array<{ to: string }> } | undefined)?.rename ?? []).map((entry) => entry.to));

  it("drops the older prepared one, applying only the newer committed one", async () => {
    const older = await sheetsOffRow({ to: "plan" });
    const newer = await sheetsOffRow({}, "committed");
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, sheetsOn: async () => false });
    expect(result.outcomes.get(older)).toBe("dropped");
    expect(result.outcomes.get(newer)).toBe("completed");
    expect(sentTo(calls)).toEqual(["city-map"]);
    expect(rowsLeft()).toEqual([]);
  });

  it("keeps the older one while the newer is only prepared, since a stale head may yet delete the newer", async () => {
    const older = await sheetsOffRow({ to: "plan" });
    await sheetsOffRow();
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, opIds: [older], sheetsOn: async () => false });
    expect(result.outcomes.get(older)).toBe("completed");
    expect(sentTo(calls)).toEqual(["plan"]);
  });

  it("drops it when completion is restricted to it, judging the newer one from all the project's rows", async () => {
    const older = await sheetsOffRow({ to: "plan" });
    await sheetsOffRow({}, "committed");
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, opIds: [older], sheetsOn: async () => false });
    expect(result.outcomes.get(older)).toBe("dropped");
    expect(calls).toEqual([]);
    expect(rowsLeft()).toHaveLength(1);
  });

  it("applies it when the newer rename is from another id, or goes through objects.csv", async () => {
    const older = await sheetsOffRow({ to: "plan" });
    await sheetsOffRow({ from: "bell", to: "bell-2" });
    await renameRow("prepared");
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, opIds: [older], sheetsOn: async () => false });
    expect(result.outcomes.get(older)).toBe("completed");
    expect(sentTo(calls)).toEqual(["plan"]);
  });

  it("keeps a committed older one, which a newer one does not supersede", async () => {
    const older = await sheetsOffRow({ to: "plan" }, "committed");
    await sheetsOffRow();
    const { env, calls } = renameEnv();
    const result = await completePendingObjectOps(env, db, PROJECT_ID, sheetOf("bell"), { now: NOW, opIds: [older], sheetsOn: async () => true });
    expect(result.outcomes.get(older)).toBe("completed");
    expect(sentTo(calls)).toEqual(["plan"]);
  });
});
