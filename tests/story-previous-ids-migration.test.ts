/**
 * Migration 0073, `story_previous_ids` and its backfill.
 *
 * The backfill records what `stories.source_path` already says: a story whose
 * file in the spreadsheets folder is named for an ID other than its own held
 * that ID before. The chain is replayed up to 0072, stories are written
 * as they stood then, and 0073 is applied over them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "db", "migrations");
const MIGRATION = "0073_story_previous_ids.sql";
const SHEETS = "telar-content/spreadsheets";

let db: DatabaseSync;

function chainBefore0073(): DatabaseSync {
  const opened = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf(MIGRATION);
  expect(at).toBeGreaterThan(0);
  for (const file of files.slice(0, at)) opened.exec(readFileSync(join(migrationsDir, file), "utf-8"));
  opened.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, " +
      "access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  opened.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1), (2, 1, 'o/b', 1)");
  return opened;
}

function addStory(projectId: number, storyId: string, sourcePath: string | null): number {
  const row = db
    .prepare("INSERT INTO stories (project_id, story_id, source_path) VALUES (?, ?, ?) RETURNING id")
    .get(projectId, storyId, sourcePath) as { id: number };
  return row.id;
}

function apply0073(): void {
  db.exec(readFileSync(join(migrationsDir, MIGRATION), "utf-8"));
}

function records(): Array<{ project_id: number; story_id: string; story_row_id: number }> {
  return db
    .prepare("SELECT project_id, story_id, story_row_id FROM story_previous_ids ORDER BY project_id, story_id")
    .all() as Array<{ project_id: number; story_id: string; story_row_id: number }>;
}

afterEach(() => {
  db.close();
});

describe("0073: story_previous_ids backfill", () => {
  it("records no story for an ID two stories of a project recorded, and still the other project's", () => {
    db = chainBefore0073();
    addStory(1, "b", `${SHEETS}/a.csv`);
    addStory(1, "c", `${SHEETS}/a.csv`);
    const elsewhere = addStory(2, "d", `${SHEETS}/a.csv`);
    apply0073();
    expect(records()).toEqual([{ project_id: 2, story_id: "a", story_row_id: elsewhere }]);
  });

  it("records a renamed story's old ID from the file it was last written to", () => {
    db = chainBefore0073();
    const row = addStory(1, "fluidity", `${SHEETS}/blank_template.csv`);

    apply0073();

    expect(records()).toEqual([{ project_id: 1, story_id: "blank_template", story_row_id: row }]);
  });

  it("records nothing for a story at its own file, an older copy's path, no path, or a parked ID", () => {
    db = chainBefore0073();
    addStory(1, "river", `${SHEETS}/river.csv`);
    addStory(1, "maps", "_data/blank_template.csv");
    addStory(1, "delta", "blank_template.csv");
    addStory(1, "never_published", null);
    addStory(1, "~5", `${SHEETS}/parked.csv`);
    addStory(1, "nested", `${SHEETS}/deeper/old.csv`);

    apply0073();

    expect(records()).toEqual([]);
  });

  it("records each project's renamed story in that project", () => {
    db = chainBefore0073();
    const one = addStory(1, "fluidity", `${SHEETS}/blank_template.csv`);
    const two = addStory(2, "process", `${SHEETS}/blank_template.csv`);

    apply0073();

    expect(records()).toEqual([
      { project_id: 1, story_id: "blank_template", story_row_id: one },
      { project_id: 2, story_id: "blank_template", story_row_id: two },
    ]);
  });
});
