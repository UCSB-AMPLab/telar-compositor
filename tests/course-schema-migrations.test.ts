/**
 * Migration/schema alignment for the course-projects chain (0036–0041).
 *
 * The Drizzle journal stops at 0006 and `drizzle-kit` never regenerates these
 * files, so the SQL and `app/db/schema.ts` are two hand-maintained copies of
 * one truth. This suite pins the invariants that make them one: the columns
 * each migration adds, the FK delete behaviour the design depends on
 * (`ON DELETE SET NULL` everywhere a course reference or an attribution can
 * outlive its target), the widened role CHECK, the named unique indexes the
 * two table rebuilds must recreate, and the legacy backfill that keeps
 * pending invite links resolving exactly as before.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { projects, project_config, project_members, project_invites, objects, code_redemption_attempts } from "~/db/schema";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "app", "db", "migrations");

/** The parenthesised column list of a rebuild's INSERT, as individual names. */
function insertColumns(sql: string, table: string): string[] {
  const from = sql.indexOf(`INSERT INTO ${table}_new`);
  const open = sql.indexOf("(", from);
  const close = sql.indexOf(")", open);
  return sql
    .slice(open + 1, close)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

function migration(prefix: string): string {
  const file = readdirSync(migrationsDir).find((f) => f.startsWith(prefix) && f.endsWith(".sql"));
  if (!file) throw new Error(`no migration file starting ${prefix}`);
  return readFileSync(join(migrationsDir, file), "utf-8");
}

/** Column names Drizzle knows for a table, in declaration order. */
function drizzleColumns(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

describe("0036 — projects.kind / parent_project_id", () => {
  const sql = migration("0036");

  it("adds kind as NOT NULL defaulting to 'site'", () => {
    expect(sql).toMatch(/ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'site'/);
  });

  it("adds parent_project_id as a nullable self-reference with ON DELETE SET NULL", () => {
    expect(sql).toMatch(
      /ALTER TABLE projects ADD COLUMN parent_project_id INTEGER REFERENCES projects\(id\) ON DELETE SET NULL/,
    );
  });

  it("declares both columns in schema.ts", () => {
    expect(drizzleColumns(projects)).toEqual(expect.arrayContaining(["kind", "parent_project_id"]));
  });
});

describe("0037 — project_config.skip_stories", () => {
  it("adds skip_stories NOT NULL defaulting to 0", () => {
    expect(migration("0037")).toMatch(
      /ALTER TABLE project_config ADD COLUMN skip_stories INTEGER NOT NULL DEFAULT 0/,
    );
  });

  it("declares skip_stories in schema.ts", () => {
    expect(drizzleColumns(project_config)).toContain("skip_stories");
  });
});

describe("0038 — project_members rebuild", () => {
  const sql = migration("0038");

  it("defers foreign keys for the rebuild", () => {
    expect(sql).toMatch(/PRAGMA defer_foreign_keys\s*=\s*true/i);
  });

  it("widens the role CHECK to three roles", () => {
    expect(sql).toMatch(/CHECK\(role IN \('convenor','collaborator','instructor'\)\)/);
  });

  it("adds joined_via_invite_id with ON DELETE SET NULL", () => {
    expect(sql).toMatch(
      /joined_via_invite_id INTEGER REFERENCES project_invites\(id\) ON DELETE SET NULL/,
    );
  });

  it("carries exactly the nine existing columns through the INSERT, id included", () => {
    expect(insertColumns(sql, "project_members").sort()).toEqual([
      "id", "project_id", "user_id", "role", "invited_at",
      "joined_at", "welcomed_at", "presence_color", "contributions",
    ].sort());
  });

  it("recreates the named project_members_unique index", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX project_members_unique ON project_members \(project_id, user_id\)/,
    );
  });

  it("declares joined_via_invite_id and the instructor role in schema.ts", () => {
    expect(drizzleColumns(project_members)).toContain("joined_via_invite_id");
    const roleCol = project_members.role as unknown as { enumValues: string[] };
    expect(roleCol.enumValues).toEqual(["convenor", "collaborator", "instructor"]);
  });
});

describe("0039 — project_invites rebuild", () => {
  const sql = migration("0039");

  it("defers foreign keys for the rebuild", () => {
    expect(sql).toMatch(/PRAGMA defer_foreign_keys\s*=\s*true/i);
  });

  it("makes created_by and used_by nullable with ON DELETE SET NULL", () => {
    expect(sql).toMatch(/created_by INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
    expect(sql).toMatch(/used_by INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  });

  it("adds the code columns", () => {
    expect(sql).toMatch(/conferred_role TEXT NOT NULL/);
    expect(sql).toMatch(/revoked_at TEXT/);
    expect(sql).toMatch(/label TEXT/);
  });

  it("backfills legacy rows as collaborator invites, used_at and expiry carried", () => {
    const cols = insertColumns(sql, "project_invites");
    expect(cols).toContain("used_at");
    expect(cols).toContain("expires_at");
    const from = sql.indexOf("INSERT INTO project_invites_new");
    expect(sql.slice(from, sql.indexOf("DROP TABLE", from))).toMatch(/'collaborator', 1, NULL, NULL/);
  });

  it("recreates the named project_invites_token_unique index", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX project_invites_token_unique ON project_invites \(token\)/);
  });

  it("declares the code columns in schema.ts", () => {
    const cols = drizzleColumns(project_invites);
    expect(cols).toEqual(
      expect.arrayContaining(["conferred_role", "revoked_at", "label"]),
    );
  });
});

// The use limit and the mandatory expiry shipped in 0039 and were withdrawn
// afterwards, so the reversal is its own migration rather than an edit to one
// staging had already applied — the chain is the same everywhere.
describe("0042 — no use limit, optional expiry", () => {
  const sql = migration("0042");

  it("defers foreign keys for the rebuild", () => {
    expect(sql).toMatch(/PRAGMA defer_foreign_keys\s*=\s*true/i);
  });

  it("drops the use limit", () => {
    expect(sql).not.toMatch(/max_uses/);
  });

  it("makes expires_at nullable, so a code can never expire", () => {
    expect(sql).toMatch(/expires_at TEXT,/);
    expect(sql).not.toMatch(/expires_at TEXT NOT NULL/);
  });

  it("carries the code columns through verbatim rather than re-backfilling", () => {
    const from = sql.indexOf("INSERT INTO project_invites_new");
    const body = sql.slice(from, sql.indexOf("DROP TABLE", from));
    expect(body).toMatch(/conferred_role, revoked_at, label\n\s*FROM project_invites/);
    expect(body).not.toMatch(/'collaborator'/);
  });

  it("recreates the named project_invites_token_unique index", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX project_invites_token_unique ON project_invites \(token\)/);
  });

  it("leaves schema.ts with no use cap and a nullable expiry", () => {
    const cols = drizzleColumns(project_invites);
    expect(cols).not.toContain("max_uses");
    expect(project_invites.expires_at.notNull).toBe(false);
  });
});

describe("0040 — objects rebuild", () => {
  const sql = migration("0040");
  const schemaCols = drizzleColumns(objects);

  it("defers foreign keys for the rebuild", () => {
    expect(sql).toMatch(/PRAGMA defer_foreign_keys\s*=\s*true/i);
  });

  it("adds course_project_id with ON DELETE SET NULL", () => {
    expect(sql).toMatch(
      /course_project_id INTEGER REFERENCES projects\(id\) ON DELETE SET NULL/,
    );
  });

  it("redeclares created_by with ON DELETE SET NULL", () => {
    expect(sql).toMatch(/created_by INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  });

  it("carries exactly the 23 pre-0040 columns through the INSERT", () => {
    // Frozen at 0040's writing — the live schema may grow past this file.
    expect(insertColumns(sql, "objects").sort()).toEqual([
      "id", "project_id", "object_id", "title", "featured", "creator",
      "description", "source_url", "period", "year", "object_type",
      "subjects", "source", "credit", "thumbnail", "image_available",
      "missing_from_repo", "origin", "alt_text", "dimensions",
      "extra_columns", "created_by", "updated_at",
    ].sort());
  });

  it("declares course_project_id in schema.ts", () => {
    expect(schemaCols).toContain("course_project_id");
  });
});

describe("0041 — code_redemption_attempts", () => {
  const sql = migration("0041");

  it("creates the per-user rate-limit row", () => {
    expect(sql).toMatch(/CREATE TABLE code_redemption_attempts/);
    expect(sql).toMatch(/user_id INTEGER PRIMARY KEY/);
    expect(sql).toMatch(/window_start TEXT NOT NULL/);
    expect(sql).toMatch(/count INTEGER NOT NULL DEFAULT 0/);
  });

  it("declares the table in schema.ts", () => {
    expect(drizzleColumns(code_redemption_attempts)).toEqual(
      expect.arrayContaining(["user_id", "window_start", "count"]),
    );
  });
});
