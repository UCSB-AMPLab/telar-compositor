/**
 * The objects check reports the commit it read (`headSha`): the one it
 * resolves, or the one a caller pins it to.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
  };
});

import { computeSyncDiff } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { PROJECT_ID, seedProject } from "./helpers/collaboration-fixture";

const CHECKED = "a".repeat(40);
const MOVED = "b".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
const events: string[] = [];
let head: string;
/** objects.csv at each commit. */
let sheets: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  head = CHECKED;
  sheets = {
    [CHECKED]: "object_id,title\no1,Reviewed title\n",
    [MOVED]: "object_id,title\no1,Changed since the check\n",
  };
  vi.mocked(getRepoHead).mockImplementation(async () => {
    events.push("head");
    return head;
  });
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
    events.push(`read:${path.split("/").pop()}@${ref}`);
    return path === OBJECTS_CSV && sheets[ref] !== undefined
      ? { status: "ok", content: sheets[ref] }
      : { status: "absent" };
  });
  vi.mocked(getRepoTree).mockImplementation(async (_t, _o, _r, ref) => {
    events.push(`tree@${ref}`);
    return { tree: [], truncated: false };
  });
});

afterEach(() => {
  memory.close();
});

describe("the objects check says what it read", () => {
  it("returns the commit it read the sheet and the tree at", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db);

    expect(diff.headSha).toBe(CHECKED);
    // The site's version is read at the same commit (`siteVersionAtRef`).
    expect(events).toEqual([
      "head", `read:objects.csv@${CHECKED}`, `tree@${CHECKED}`, `read:_config.yml@${CHECKED}`,
    ]);
  });

  it("returns the commit a caller pins it to", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, MOVED);

    expect(diff.headSha).toBe(MOVED);
    expect(getRepoHead).not.toHaveBeenCalled();
  });
});
