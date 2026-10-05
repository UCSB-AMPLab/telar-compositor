/**
 * glossary.csv is written in the document's order, `order_key` ascending then
 * `id`, which is the order the collaboration room seeds the glossary in and so
 * the order the preview keeps the first id at a shared address in. The build
 * keeps the first id in the file at an address, so a publish that read the rows
 * in the order D1 happens to return them could keep the other one.
 *
 * The rows' `order_key` runs against their ids, as it does once an author has
 * moved terms. D1 is the repository's migration chain in memory.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import Papa from "papaparse";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;

vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(memory), { schema }) }));
vi.mock("~/lib/github.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getFileAtRef: vi.fn(async () => ({ status: "absent" })),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ProjectCollaborationDO } from "../workers/collaboration";
import { markLoaded } from "./helpers/claimed-document";
import { buildPublishFileSet, runPrePublishValidation } from "~/lib/publish.server";
import { glossaryTermsFromDoc } from "~/lib/glossary-links";
import * as Y from "yjs";
const PROJECT_ID = 42;
const GLOSSARY_CSV = "telar-content/spreadsheets/glossary.csv";

/** Rows by id; each row's order_key runs the other way (a higher id, an earlier key). */
function addTerms(ids: Array<[number, string]>): void {
  for (const [id, termId] of ids) {
    memory.raw
      .prepare("INSERT INTO glossary_terms (id, project_id, term_id, title, order_key) VALUES (?, ?, ?, ?, ?)")
      .run(id, PROJECT_ID, termId, `Title ${termId}`, `k${1000 - id}`);
  }
}

async function publishedTermIds(): Promise<string[]> {
  const files = await buildPublishFileSet({
    token: "tok",
    owner: "owner",
    repo: "repo",
    ref: "sha",
    projectId: PROJECT_ID,
    env: { DB: {} } as never,
    configYml: null,
    config: null,
  } as never);
  const csv = files.find((f) => f.path === GLOSSARY_CSV)?.content ?? "";
  // Header, then the bilingual row, then the terms.
  return Papa.parse<string[]>(csv, { skipEmptyLines: true }).data.slice(2).map((r) => r[0]);
}

/**
 * The glossary document the collaboration room builds from D1 (`buildFromD1Rows`,
 * the room's own seed query), and the term ids in the array's order.
 */
async function seededDocument(): Promise<{ doc: Y.Doc; order: string[] }> {
  const ctx = {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const room = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: "s", COLLABORATION: {} } as unknown as Env,
  );
  (room as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(room);
  await (room as unknown as { buildFromD1Rows: () => Promise<void> }).buildFromD1Rows();
  const doc = (room as unknown as { ydoc: Y.Doc }).ydoc;
  const order = doc.getArray<Y.Map<unknown>>("glossary").toArray().map((m) => String(m.get("term_id")));
  return { doc, order };
}

beforeEach(() => {
  memory = createMemoryD1();
  // With the (project_id, order_key) index a read with no ORDER BY is handed
  // the rows in key order by the planner, which would let an unordered read
  // pass. Without it the rows come back in insertion order, as they may for
  // any other plan.
  memory.raw.exec("DROP INDEX glossary_terms_project_order_key");
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, 7, 'owner/repo', 5)`);
});

afterEach(() => {
  memory.close();
});

describe("the order publish writes glossary.csv in", () => {
  it("is the list order, order_key ascending, whatever the rows' ids or names say", async () => {
    addTerms([[1, "zeta"], [2, "alpha"], [3, "mid"]]);
    expect(await publishedTermIds()).toEqual(["mid", "alpha", "zeta"]);
  });

  it("keeps, in the document the room seeds, the id the published file puts first", async () => {
    addTerms([[1, "iiif"], [2, "IIIF"]]);
    const written = await publishedTermIds();
    const seeded = await seededDocument();
    expect(written).toEqual(["IIIF", "iiif"]);
    expect(seeded.order).toEqual(written);
    expect([...glossaryTermsFromDoc(seeded.doc).keys()]).toEqual(["IIIF"]);
  });
});

describe("the warning for ids that share an address", () => {
  const base = { headSha: "a", currentRepoHead: "a", stories: [], steps: [], objects: [], pages: [] };
  const validate = (glossary: Array<{ term_id: string; title: string }>) =>
    runPrePublishValidation({ ...base, glossary });

  it("names the id the site keeps and the one it drops, and does not block", () => {
    const { blockers, warnings } = validate([
      { term_id: "colonial-period", title: "A" },
      { term_id: "Colonial Period", title: "B" },
    ]);
    expect(warnings.filter((w) => w.code === "glossary_shared_address")).toEqual([
      expect.objectContaining({ entityId: "Colonial Period", params: { kept: "colonial-period", dropped: "Colonial Period" } }),
    ]);
    expect(blockers.filter((b) => b.code.startsWith("glossary"))).toEqual([]);
  });

  it("uses the case variant where the dropped id differs only in case, since its links open the kept term", () => {
    const { warnings } = validate([
      { term_id: "IIIF", title: "A" },
      { term_id: "iiif", title: "B" },
    ]);
    expect(warnings.filter((w) => w.code.startsWith("glossary_shared_address")).map((w) => [w.code, w.entityId])).toEqual([
      ["glossary_shared_address_case", "iiif"],
    ]);
  });

  it("warns once for each id dropped at an address", () => {
    const { warnings } = validate([
      { term_id: "a b", title: "A" },
      { term_id: "a-b", title: "B" },
      { term_id: "a_b", title: "C" },
    ]);
    expect(warnings.filter((w) => w.code === "glossary_shared_address").map((w) => w.entityId)).toEqual(["a-b", "a_b"]);
  });

  it("does not count a row with no title as holding an address", () => {
    const { warnings } = validate([
      { term_id: "x", title: "" },
      { term_id: "X", title: "B" },
    ]);
    expect(warnings.filter((w) => w.code === "glossary_shared_address")).toEqual([]);
  });

  it("is silent when every address is its own", () => {
    const { warnings } = validate([
      { term_id: "a", title: "A" },
      { term_id: "b", title: "B" },
    ]);
    expect(warnings.filter((w) => w.code === "glossary_shared_address")).toEqual([]);
  });
});
