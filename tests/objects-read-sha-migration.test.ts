/**
 * Migration 0061, `projects.objects_read_sha`: the last commit whose
 * objects.csv object rows D1 accounts for.
 *
 * A project that existed before the column takes its `head_sha`, a commit
 * whose every file the Compositor has read; a project with no head recorded
 * stays NULL. The chain is replayed up to 0060, rows are written in the shape
 * they had then, and 0061 is applied over them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "db", "migrations");
const MIGRATION = "0061_projects_objects_read_sha.sql";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

let db: DatabaseSync;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf(MIGRATION);
  expect(at).toBeGreaterThan(0);
  for (const file of files.slice(0, at)) db.exec(readFileSync(join(migrationsDir, file), "utf-8"));

  db.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, " +
      "access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  db.exec(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, head_sha) VALUES " +
      `(1, 1, 'o/read', 1, '${HEAD}'), (2, 1, 'o/unread', 1, NULL)`,
  );

  db.exec(readFileSync(join(migrationsDir, MIGRATION), "utf-8"));
});

afterAll(() => {
  db.close();
});

function readShaOf(id: number): unknown {
  return (db.prepare("SELECT objects_read_sha FROM projects WHERE id = ?").get(id) as { objects_read_sha: unknown })
    .objects_read_sha;
}

describe("0061: projects.objects_read_sha", () => {
  it("sets an existing project's record to its recorded head", () => {
    expect(readShaOf(1)).toBe(HEAD);
  });

  it("leaves a project with no recorded head with no record", () => {
    expect(readShaOf(2)).toBeNull();
  });

  it("gives a project inserted afterwards no record until something reads objects.csv", () => {
    db.exec(
      "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, head_sha) " +
        `VALUES (3, 1, 'o/new', 1, '${HEAD}')`,
    );
    expect(readShaOf(3)).toBeNull();
  });
});
