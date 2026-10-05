/**
 * The manifest metadata of an external IIIF object is written by the
 * collaboration server alone. The Objects loader reads no manifest and writes
 * nothing; the page's request (`enrich-external`) asks the server, signed for
 * `enrich-objects` and naming no object or URL, and answers whether it was
 * reached.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));

import { loader } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { fetchAndParseManifest } from "~/lib/iiif.server";
import { requestObjectEnrichment } from "~/lib/object-enrichment.server";
import { verifyInternalMarker } from "../workers/auth";

const PROJECT_ID = 42;
let memory: MemoryD1;

function context() {
  return { get: vi.fn(() => ({ id: 7 })), cloudflare: { env: { DB: {}, SESSION_SECRET: "s" } } } as never;
}

function storedRow(): Record<string, unknown> {
  return memory.raw.prepare("SELECT title, thumbnail, image_available FROM objects WHERE object_id = 'bell'").get() as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, 7, 'owner/repo', 5)`);
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, source_url, image_available) VALUES (5, ${PROJECT_ID}, 'bell', 'a00001', 'https://iiif.example/manifest', 0)`,
  );
  vi.mocked(getDb).mockImplementation(() => drizzle(asD1(memory), { schema }) as never);
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5 },
    userRole: "convenor",
  } as never);
  vi.mocked(fetchAndParseManifest).mockResolvedValue({
    ok: true,
    metadata: { thumbnail: "https://iiif.example/t.jpg", title: "Bell", creator: "Maker" },
  } as never);
});

afterEach(() => memory.close());

describe("the loader", () => {
  it("reads no manifest and writes nothing for an object with an empty thumbnail", async () => {
    const data = (await loader({ request: new Request("https://compositor.telar.org/objects"), context: context(), params: {} } as never)) as Record<string, unknown>;

    expect(fetchAndParseManifest).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty("enrichments");
    expect(storedRow()).toEqual({ title: null, thumbnail: null, image_available: 0 });
  });
});

describe("requestObjectEnrichment", () => {
  function envAnswering(answer: () => Promise<Response>) {
    const requests: Request[] = [];
    const env = {
      SESSION_SECRET: "s",
      COLLABORATION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async (request: Request) => { requests.push(request); return answer(); } }),
      },
    };
    return { env: env as never, requests };
  }

  it("posts /enrich-objects with no body, signed for that operation and nothing else", async () => {
    const { env, requests } = envAnswering(async () => Response.json({ filled: 1 }));

    expect(await requestObjectEnrichment(env, { project: { id: PROJECT_ID } })).toBe(true);

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/enrich-objects");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toBeNull();
    expect(await verifyInternalMarker(requests[0].clone() as never, "s", "enrich-objects")).toBeNull();
    expect(await verifyInternalMarker(requests[0].clone() as never, "s", "reset-page-frontmatter")).not.toBeNull();
  });

  it("answers false, asking nothing, without a project", async () => {
    const { env, requests } = envAnswering(async () => Response.json({ filled: 0 }));
    expect(await requestObjectEnrichment(env, null)).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("answers false for a refusal and for a server it could not reach", async () => {
    expect(await requestObjectEnrichment(envAnswering(async () => new Response("persistence_halted", { status: 503 })).env, { project: { id: PROJECT_ID } })).toBe(false);
    expect(await requestObjectEnrichment(envAnswering(async () => { throw new Error("unreachable"); }).env, { project: { id: PROJECT_ID } })).toBe(false);
  });
});
