/**
 * The write fence against real SQLite, one statement at a time.
 *
 * The unit project's fakes prove the object's branching and nothing about SQL;
 * this file proves the SQL. It runs the repository's own migration chain into
 * `node:sqlite`, so the two triggers on `projects` and the guard table's own
 * trigger are live, and every statement here is one the Durable Object issues,
 * quoted rather than paraphrased — a statement that drifts from the one in
 * `workers/collaboration.ts` proves nothing about it.
 *
 * What it cannot show: transport conversion, D1's remote limits, and anything
 * about two invocations racing. Each ordering below is a SEQUENCE of statements
 * against one row, standing in for a race this harness cannot run.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

import { createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 1;

let memory: MemoryD1;

/** The statement shapes the Durable Object issues, quoted. */
const SQL = {
  /** Every writer from before this fence, on the blob. */
  preStepBlob: "UPDATE projects SET yjs_state = ?, updated_at = ? WHERE id = ?",
  /** Every writer from before this fence, clearing the blob. */
  preStepClear: "UPDATE projects SET yjs_state = NULL, updated_at = ? WHERE id = ?",
  claim: "UPDATE projects SET yjs_write = ? WHERE id = ? AND yjs_write = ?",
  tag:
    "UPDATE projects SET yjs_generation = ?, yjs_seq = 0, yjs_write = ? WHERE id = ? " +
    "AND yjs_generation IS NULL AND yjs_seq IS NULL AND yjs_state = ? AND yjs_write = ?",
  initial:
    "UPDATE projects SET yjs_state = ?, yjs_generation = ?, yjs_seq = 0, yjs_write = ? " +
    "WHERE id = ? AND yjs_state IS NULL AND yjs_generation IS NULL AND yjs_seq IS NULL " +
    "AND yjs_write = ?",
  base:
    "UPDATE projects SET yjs_state = ?, yjs_generation = ?, yjs_seq = ?, yjs_write = ?, " +
    "updated_at = ? WHERE id = ? AND yjs_write = ?",
  guardInsert: "INSERT INTO yjs_write_guard (project_id, expected) VALUES (?, ?)",
  advance: "UPDATE projects SET yjs_write = ? WHERE id = ?",
  guardDelete: "DELETE FROM yjs_write_guard WHERE project_id = ?",
};

const NOW = "2026-09-07T00:00:00.000Z";

function bytes(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("config").set("title", text);
  return Y.encodeStateAsUpdate(doc);
}

const BASE_BYTES = bytes("one");

/** Run one statement, reporting the rows it changed. */
function run(sql: string, ...binds: unknown[]): number {
  const result = memory.raw.prepare(sql).run(...(binds as never[]));
  return Number(result.changes);
}

function row(): {
  yjs_state: Uint8Array | null;
  yjs_generation: number | null;
  yjs_seq: number | null;
  yjs_write: number;
} {
  return memory.raw
    .prepare("SELECT yjs_state, yjs_generation, yjs_seq, yjs_write FROM projects WHERE id = ?")
    .get(PROJECT_ID) as never;
}

function guardRows(): number {
  const counted = memory.raw
    .prepare("SELECT COUNT(*) AS n FROM yjs_write_guard")
    .get() as { n: number };
  return Number(counted.n);
}

/** Seed one project row and put it in whatever state the case needs. */
function seed(state: {
  blob?: Uint8Array | null;
  generation?: number | null;
  seq?: number | null;
  revision?: number;
} = {}) {
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, " +
      "encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw
    .prepare(
      "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, " +
        "yjs_state, yjs_generation, yjs_seq, yjs_write) VALUES (?, 1, 'o/a', 1, ?, ?, ?, ?)",
    )
    .run(
      PROJECT_ID,
      (state.blob ?? null) as never,
      (state.generation ?? null) as never,
      (state.seq ?? null) as never,
      state.revision ?? 0,
    );
}

beforeEach(() => {
  memory = createMemoryD1();
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// What the database refuses on its own
// ---------------------------------------------------------------------------

describe("the fence trigger enrols a row for good once its revision has moved", () => {
  it("lets a statement from before the fence write a row no instance has claimed", () => {
    seed();
    expect(run(SQL.preStepBlob, BASE_BYTES, NOW, PROJECT_ID)).toBe(1);
    expect(run(SQL.preStepClear, NOW, PROJECT_ID)).toBe(1);
  });

  it("refuses both of those shapes on a claimed row", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });

    expect(() => run(SQL.preStepBlob, bytes("two"), NOW, PROJECT_ID)).toThrow(/yjs_fence/);
    expect(() => run(SQL.preStepClear, NOW, PROJECT_ID)).toThrow(/yjs_fence/);
    expect(row().yjs_state).not.toBeNull();
  });

  it("keeps a claimed row enrolled after its tags are cleared by hand", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });
    // A hand repair: it moves the revision, which is what the fence requires of
    // any write that touches the blob or the tags.
    run(
      "UPDATE projects SET yjs_generation = NULL, yjs_seq = NULL, yjs_write = yjs_write + 1 " +
        "WHERE id = ?",
      PROJECT_ID,
    );

    expect(() => run(SQL.preStepBlob, bytes("two"), NOW, PROJECT_ID)).toThrow(/yjs_fence/);
  });

  it("refuses a tag change and a no-op blob assignment that do not move the revision", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });

    expect(() =>
      run("UPDATE projects SET yjs_generation = 5 WHERE id = ?", PROJECT_ID),
    ).toThrow(/yjs_fence/);
    expect(() =>
      run("UPDATE projects SET yjs_state = yjs_state WHERE id = ?", PROJECT_ID),
    ).toThrow(/yjs_fence/);
  });
});

describe("the monotonic trigger orders whatever compares", () => {
  it("refuses an unconditional advance at or below the current revision", () => {
    seed({ revision: 4 });

    expect(() => run(SQL.advance, 4, PROJECT_ID)).toThrow(/yjs_write_stale/);
    expect(() => run(SQL.advance, 3, PROJECT_ID)).toThrow(/yjs_write_stale/);
    expect(row().yjs_write).toBe(4);
  });

  it("lands on any increase", () => {
    seed({ revision: 4 });

    expect(run(SQL.advance, 5, PROJECT_ID)).toBe(1);
    expect(row().yjs_write).toBe(5);
  });

  it("refuses an advance over a revision that is text, which the loader never reaches", () => {
    // The column's INTEGER affinity admits text; the loader validates what it
    // reads and refuses such a row as `bad_revision` before any statement, so
    // this is the database's own backstop rather than a path the object takes.
    seed();
    memory.raw.prepare("UPDATE projects SET yjs_write = 'x' WHERE id = ?").run(PROJECT_ID);

    expect(() => run(SQL.advance, 1, PROJECT_ID)).toThrow(/yjs_write_stale/);
  });
});

describe("the guard asserts the revision inside the batch's own transaction", () => {
  it("lands when the row holds exactly the expected revision", () => {
    seed({ revision: 3 });

    expect(run(SQL.guardInsert, PROJECT_ID, 3)).toBe(1);
    expect(guardRows()).toBe(1);
    expect(run(SQL.guardDelete, PROJECT_ID)).toBe(1);
    expect(guardRows()).toBe(0);
  });

  it("is refused when the row is above, below, or gone", () => {
    seed({ revision: 3 });

    expect(() => run(SQL.guardInsert, PROJECT_ID, 2)).toThrow(/yjs_write_guard/);
    expect(() => run(SQL.guardInsert, PROJECT_ID, 4)).toThrow(/yjs_write_guard/);
    expect(() => run(SQL.guardInsert, PROJECT_ID + 99, 3)).toThrow(/yjs_write_guard/);
    expect(guardRows()).toBe(0);
  });

  it("aborts the whole batch, leaving no guard row behind", async () => {
    seed({ revision: 3 });
    const db = memory as unknown as {
      batch(statements: unknown[]): Promise<unknown[]>;
      prepare(sql: string): { bind(...args: unknown[]): unknown };
    };

    await expect(
      db.batch([
        db.prepare(SQL.guardInsert).bind(PROJECT_ID, 2),
        db.prepare(SQL.advance).bind(3, PROJECT_ID),
        db.prepare(SQL.guardDelete).bind(PROJECT_ID),
      ]),
    ).rejects.toThrow(/yjs_write_guard/);

    expect(row().yjs_write).toBe(3);
    expect(guardRows()).toBe(0);
  });

  it("rolls back and rethrows when the constraint fails at the COMMIT, not before", async () => {
    seed({ revision: 3 });
    const db = memory as unknown as {
      batch(statements: unknown[]): Promise<unknown[]>;
      prepare(sql: string): { bind(...args: unknown[]): unknown };
    };

    // A DEFERRED foreign key is the one class of failure that arrives at the
    // commit and nowhere else, which is the case a COMMIT outside the protected
    // body leaves half-applied: the row visible, the transaction still open,
    // and the next batch unable to begin one.
    await expect(
      db.batch([
        db.prepare("PRAGMA defer_foreign_keys = ON").bind(),
        db.prepare(SQL.advance).bind(4, PROJECT_ID),
        db.prepare(
          "INSERT INTO stories (id, project_id, story_id, title) VALUES (?, ?, ?, ?)",
        ).bind(9001, PROJECT_ID + 500, "orphan", "Orphaned story"),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/i);

    expect(row().yjs_write).toBe(3);
    const orphan = memory.raw
      .prepare("SELECT COUNT(*) AS n FROM stories WHERE id = 9001")
      .get() as { n: number };
    expect(Number(orphan.n)).toBe(0);

    // The next batch starts cleanly: a transaction left open would refuse it.
    await db.batch([
      db.prepare(SQL.guardInsert).bind(PROJECT_ID, 3),
      db.prepare(SQL.advance).bind(4, PROJECT_ID),
      db.prepare(SQL.guardDelete).bind(PROJECT_ID),
    ]);
    expect(row().yjs_write).toBe(4);
    expect(guardRows()).toBe(0);
  });

  it("commits the advance and the delete together when the guard passes", async () => {
    seed({ revision: 3 });
    const db = memory as unknown as {
      batch(statements: unknown[]): Promise<unknown[]>;
      prepare(sql: string): { bind(...args: unknown[]): unknown };
    };

    await db.batch([
      db.prepare(SQL.guardInsert).bind(PROJECT_ID, 3),
      db.prepare(SQL.advance).bind(4, PROJECT_ID),
      db.prepare(SQL.guardDelete).bind(PROJECT_ID),
    ]);

    expect(row().yjs_write).toBe(4);
    expect(guardRows()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Each conditioned statement, with the revision read and with a stale one
// ---------------------------------------------------------------------------

describe("every conditioned statement lands once and moves the revision by one", () => {
  it("the bare claim", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 2 });

    expect(run(SQL.claim, 3, PROJECT_ID, 2)).toBe(1);
    expect(row().yjs_write).toBe(3);
    expect(run(SQL.claim, 3, PROJECT_ID, 2)).toBe(0);
  });

  it("the tag on an untagged blob", () => {
    seed({ blob: BASE_BYTES, revision: 0 });

    expect(run(SQL.tag, 0, 1, PROJECT_ID, BASE_BYTES, 0)).toBe(1);
    expect(row()).toMatchObject({ yjs_generation: 0, yjs_seq: 0, yjs_write: 1 });
    expect(run(SQL.tag, 0, 1, PROJECT_ID, BASE_BYTES, 0)).toBe(0);
  });

  it("the cold build's initial blob", () => {
    seed({ revision: 0 });

    expect(run(SQL.initial, BASE_BYTES, 0, 1, PROJECT_ID, 0)).toBe(1);
    expect(row()).toMatchObject({ yjs_generation: 0, yjs_seq: 0, yjs_write: 1 });
    expect(run(SQL.initial, BASE_BYTES, 0, 2, PROJECT_ID, 1)).toBe(0);
  });

  it("the snapshot's blob write", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });
    const next = bytes("two");

    expect(run(SQL.base, next, 0, 4, 2, NOW, PROJECT_ID, 1)).toBe(1);
    expect(row()).toMatchObject({ yjs_generation: 0, yjs_seq: 4, yjs_write: 2 });
    expect(run(SQL.base, next, 0, 5, 2, NOW, PROJECT_ID, 1)).toBe(0);
  });

  it("the reset's replacement", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 3, revision: 6 });
    const rebuilt = bytes("rebuilt");

    expect(run(SQL.base, rebuilt, 1, 0, 7, NOW, PROJECT_ID, 6)).toBe(1);
    expect(row()).toMatchObject({ yjs_generation: 1, yjs_seq: 0, yjs_write: 7 });
    expect(run(SQL.base, rebuilt, 1, 0, 7, NOW, PROJECT_ID, 6)).toBe(0);
  });
});

describe("the tag compares the bytes it read", () => {
  it("lands zero rows when the stored bytes differ in their last byte", () => {
    const stored = new Uint8Array(BASE_BYTES);
    const read = new Uint8Array(BASE_BYTES);
    read[read.length - 1] = read[read.length - 1] ^ 0xff;
    seed({ blob: stored, revision: 0 });

    expect(run(SQL.tag, 0, 1, PROJECT_ID, read, 0)).toBe(0);
    expect(row().yjs_generation).toBeNull();
  });

  it("compares a view by its own bytes, not by its backing buffer", () => {
    const backing = new Uint8Array(BASE_BYTES.length + 8);
    backing.set(BASE_BYTES, 4);
    const view = new Uint8Array(backing.buffer, 4, BASE_BYTES.length);
    seed({ blob: BASE_BYTES, revision: 0 });

    expect(run(SQL.tag, 0, 1, PROJECT_ID, view, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Orderings: each is a sequence of the statements above against one row
// ---------------------------------------------------------------------------

describe("what the fence does to an invocation the platform has replaced", () => {
  it("refuses an obsolete snapshot after a replacement has claimed the row", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });
    // Stand-in for the replacement's claim, which this harness cannot run.
    expect(run(SQL.claim, 2, PROJECT_ID, 1)).toBe(1);

    expect(run(SQL.base, bytes("obsolete"), 0, 0, 2, NOW, PROJECT_ID, 1)).toBe(0);
    expect(row().yjs_write).toBe(2);
  });

  it("sends a replacement whose claim lost to an obsolete snapshot back for another read", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });
    // The obsolete invocation's blob write lands first, leaving an exact base
    // correctly attributed to it.
    expect(run(SQL.base, bytes("obsolete"), 0, 0, 2, NOW, PROJECT_ID, 1)).toBe(1);

    // The replacement's claim at the revision it read lands nothing; the second
    // read finds 2 and claims from there.
    expect(run(SQL.claim, 2, PROJECT_ID, 1)).toBe(0);
    expect(run(SQL.claim, 3, PROJECT_ID, 2)).toBe(1);
  });

  it("refuses an obsolete guard after a replacement has claimed", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });
    expect(run(SQL.claim, 2, PROJECT_ID, 1)).toBe(1); // the replacement's claim

    expect(() => run(SQL.guardInsert, PROJECT_ID, 1)).toThrow(/yjs_write_guard/);
  });

  it("refuses a reset's replacement after a snapshot moved the row", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });
    expect(run(SQL.base, bytes("snapshotted"), 0, 2, 2, NOW, PROJECT_ID, 1)).toBe(1);

    expect(run(SQL.base, bytes("reset"), 1, 0, 2, NOW, PROJECT_ID, 1)).toBe(0);
  });

  it("refuses a statement from before the fence after a reset replacement", () => {
    seed({ blob: BASE_BYTES, revision: 0 });
    expect(run(SQL.base, bytes("reset"), 1, 0, 1, NOW, PROJECT_ID, 0)).toBe(1);

    expect(() => run(SQL.preStepBlob, bytes("stale"), NOW, PROJECT_ID)).toThrow(/yjs_fence/);
  });

  it("resurrects nothing when the project row is deleted between a read and each write", () => {
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });
    memory.raw.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT_ID);

    expect(run(SQL.claim, 2, PROJECT_ID, 1)).toBe(0);
    expect(run(SQL.base, bytes("two"), 0, 0, 2, NOW, PROJECT_ID, 1)).toBe(0);
    expect(() => run(SQL.guardInsert, PROJECT_ID, 1)).toThrow(/yjs_write_guard/);
    expect(
      memory.raw.prepare("SELECT COUNT(*) AS n FROM projects").get(),
    ).toMatchObject({ n: 0 });
  });

  it("leaves the same bytes at a moved revision when a write changed nothing", () => {
    // The ordering re-acquisition must not adopt on the bytes alone: an
    // intended identical write and a replacement's bare claim leave a row that
    // reads the same, which is why the ownership validation is what decides.
    seed({ blob: BASE_BYTES, generation: 0, seq: 0, revision: 1 });

    expect(run(SQL.base, BASE_BYTES, 0, 0, 2, NOW, PROJECT_ID, 1)).toBe(1);
    const after = row();
    expect(after.yjs_write).toBe(2);
    expect(new Uint8Array(after.yjs_state as Uint8Array)).toEqual(BASE_BYTES);
  });
});
