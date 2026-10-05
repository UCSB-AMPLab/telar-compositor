/**
 * The fingerprint a full sync check records under.
 *
 * The full check compares objects, stories with their step and layer files,
 * the glossary, the settings and the pages, and the full sync's apply writes
 * each under the objects lease. The check, and the status refresh that runs
 * it, record a head only while D1 answers the fingerprint taken before the
 * check read anything (`syncedRowsFingerprint`), so a write to any of them,
 * during the check or after it, leaves the record for the next check. Rows
 * of another project are not compared and do not move it. When each caller
 * takes it is pinned by tests/dashboard-sync-check-head.test.ts and
 * tests/github-status-record-lease.test.ts.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { PROJECT_ID, seedProject } from "./helpers/collaboration-fixture";

// The fixture's module reaches the collaboration object's, which imports this.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { syncedRowsFingerprint } from "~/lib/synced-rows-fingerprint.server";

let memory: MemoryD1;

function fingerprintedDb() {
  return drizzle(asD1(memory), { schema });
}

function fingerprint(projectId = PROJECT_ID): Promise<string> {
  return syncedRowsFingerprint(fingerprintedDb(), projectId);
}

beforeEach(() => {
  memory = createMemoryD1();
  seedProject(memory, "text");
});

afterEach(() => {
  memory.close();
});

describe("the rows the fingerprint covers", () => {
  const writes: Array<[string, string]> = [
    ["an object's field", "UPDATE objects SET title = 'Other' WHERE id = 1"],
    ["a story's row", "UPDATE stories SET title = 'Other' WHERE id = 1"],
    ["a step", "UPDATE steps SET question = 'Other' WHERE id = 1"],
    ["a layer", "UPDATE layers SET title = 'Other' WHERE id = 1"],
    ["a glossary term", "UPDATE glossary_terms SET definition = 'Other' WHERE id = 1"],
    ["a setting", "UPDATE project_config SET title = 'Other' WHERE project_id = 1"],
    ["a page", "UPDATE project_pages SET body = 'Other' WHERE id = 1"],
  ];

  it.each(writes)("moves when %s is written", async (_what, write) => {
    const before = await fingerprint();
    memory.raw.exec(write);
    expect(await fingerprint()).not.toBe(before);
  });

  it("answers the same over rows nothing has written", async () => {
    expect(await fingerprint()).toBe(await fingerprint());
  });

  it("does not move for another project's rows", async () => {
    const before = await fingerprint();
    memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (2, 1, 'o/b', 2)");
    memory.raw.exec("INSERT INTO stories (id, project_id, story_id, title, \"order\", order_key) VALUES (2, 2, 's2', 'T', 0, 'a00001')");
    memory.raw.exec("INSERT INTO steps (id, story_id, step_number, order_key, kind) VALUES (2, 2, 1, 'a00001', 'media')");
    memory.raw.exec("INSERT INTO glossary_terms (id, project_id, term_id, order_key, title) VALUES (2, 2, 't2', 'a00001', 'T')");
    expect(await fingerprint()).toBe(before);
  });
});
