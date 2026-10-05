/**
 * Migration 0069, `pending_object_ops` rebuilt for the `rename` kind.
 *
 * The collaboration object keeps its receipts by operation id, so an id must
 * never be reused: the rebuilt table carries AUTOINCREMENT's high-water mark,
 * including when the rows above the highest surviving id were deleted. The
 * chain is replayed up to 0068, rows are written and deleted in the shape they
 * had then, and 0069 is applied over them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "db", "migrations");
const MIGRATION = "0069_pending_object_ops_rename.sql";

let db: DatabaseSync;

function chainBefore0069(withProject: boolean): DatabaseSync {
  const opened = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf(MIGRATION);
  expect(at).toBeGreaterThan(0);
  for (const file of files.slice(0, at)) opened.exec(readFileSync(join(migrationsDir, file), "utf-8"));
  if (withProject) {
    opened.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, " +
        "access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
    );
    opened.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
  }
  return opened;
}

function insertOp(kind = "register"): number {
  const row = db
    .prepare(
      "INSERT INTO pending_object_ops (project_id, kind, state, payload, created_at) " +
        "VALUES (1, ?, 'prepared', '[]', '2026-10-01T00:00:00.000Z') RETURNING id",
    )
    .get(kind) as { id: number };
  return row.id;
}

function sequence(): number | undefined {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'pending_object_ops'").get() as
    | { seq: number }
    | undefined;
  return row?.seq;
}

function apply0069(): void {
  db.exec(readFileSync(join(migrationsDir, MIGRATION), "utf-8"));
}

afterEach(() => {
  db.close();
});

describe("0069: pending_object_ops accepts rename", () => {
  it("issues an id above the old sequence when the highest rows were deleted", () => {
    db = chainBefore0069(true);
    const kept = insertOp();
    for (let i = 0; i < 4; i++) insertOp();
    db.exec(`DELETE FROM pending_object_ops WHERE id > ${kept}`);
    const before = sequence()!;
    expect(before).toBe(kept + 4);

    apply0069();

    expect(insertOp("rename")).toBeGreaterThan(before);
    expect(db.prepare("SELECT id FROM pending_object_ops WHERE id = ?").get(before)).toBeUndefined();
  });

  it("issues an id above the old sequence when every row was deleted", () => {
    db = chainBefore0069(true);
    insertOp();
    insertOp();
    db.exec("DELETE FROM pending_object_ops");
    const before = sequence()!;

    apply0069();

    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_object_ops").get()).toEqual({ n: 0 });
    expect(insertOp()).toBeGreaterThan(before);
  });

  it("keeps every row, its columns and the index", () => {
    db = chainBefore0069(true);
    const id = insertOp("remove");
    db.prepare("UPDATE pending_object_ops SET state = 'committed', commit_sha = 'c1', parent_sha = 'p1', actor_id = 1 WHERE id = ?").run(id);
    const before = db.prepare("SELECT * FROM pending_object_ops").all();

    apply0069();

    expect(db.prepare("SELECT * FROM pending_object_ops").all()).toEqual(before);
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_object_ops'").all();
    expect(index).toEqual([{ name: "pending_object_ops_project" }]);
  });

  it("accepts rename and still refuses a kind or state it does not name", () => {
    db = chainBefore0069(true);
    expect(() => insertOp("rename")).toThrow();

    apply0069();

    expect(insertOp("rename")).toBeGreaterThan(0);
    expect(() => insertOp("purge")).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO pending_object_ops (project_id, kind, state, payload, created_at) VALUES (1, 'rename', 'done', '[]', 'x')",
      ),
    ).toThrow();
  });

  it("applies on a database with no project", () => {
    db = chainBefore0069(false);
    apply0069();
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_object_ops").get()).toEqual({ n: 0 });
  });
});
