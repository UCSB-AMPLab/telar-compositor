/**
 * The object's page reads, lists and deletes an object by the id the site
 * gives it.
 *
 * For a self-hosted row written `map.jpg` the site tiles `map`, so the page's
 * viewer reads `iiif/objects/map/…`; a step naming `map` shows it on the site,
 * so it is listed among the object's uses; and deleting it from the repository
 * removes the file `map.jpg` the site found for it, unless another row, `map`,
 * reads as the same object and so owns the file too.
 *
 * D1 is the repository's migration chain in memory.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const CONVENOR = 7;
const BASE = "https://example.org/site";

let memory: MemoryD1;
let treePaths: string[] = [];
let sheet = "";
/** The repository's `_config.yml` at the captured head, or null for none. */
let repoConfig: string | null = null;

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
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(memory), { schema }) }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/upgrade-gate.server", () => ({ readRepoWriteRefusal: vi.fn(async () => null) }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
  getInstallationInfo: vi.fn(),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "captured-head"),
  getRepoTree: vi.fn(async () => ({
    tree: treePaths.map((path) => ({ path, mode: "100644", type: "blob", sha: "x" })),
    truncated: false,
  })),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
    path === "_config.yml"
      ? repoConfig === null ? { status: "absent" } : { status: "ok", content: repoConfig }
      : { status: "ok", content: sheet },
  ),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "sha-after-delete" })),
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/iiif-types", () => ({ deriveStatus: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), getYText: vi.fn() }));
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: vi.fn() }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: vi.fn() }));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: vi.fn() }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: vi.fn() }));
vi.mock("~/components/ui/Switch", () => ({ Switch: vi.fn() }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: vi.fn() }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: vi.fn() }));

import { action, loader } from "~/routes/_app.objects.$objectId";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { commitFilesToRepo } from "~/lib/commit.server";

function context() {
  const stub = {
    fetch: async (req: Request) => {
      const body = JSON.parse(await req.text()) as { objects: { remove: Array<{ objectId: string; docId: number }> } };
      const removes = body.objects.remove;
      for (const r of removes) memory.raw.prepare("DELETE FROM objects WHERE id = ?").run(r.docId);
      return Response.json({
        applied: { objectRemove: removes.length },
        removals: { applied: removes.map((r) => r.objectId), absent: [], superseded: [], course: [] },
      });
    },
  };
  return {
    get: vi.fn(() => ({ id: CONVENOR, encrypted_access_token: "enc" })),
    cloudflare: {
      env: {
        ENCRYPTION_KEY: "k",
        SESSION_SECRET: "s",
        DB: {},
        GITHUB_APP_ID: "a",
        GITHUB_PRIVATE_KEY: "p",
        COLLABORATION: { idFromName: (n: string) => n, get: () => stub },
      },
    },
  } as never;
}

function addObject(id: number, objectId: string, sourceUrl: string | null = null): void {
  memory.raw
    .prepare(
      "INSERT INTO objects (id, project_id, object_id, order_key, title, created_by, source_url) VALUES (?, ?, ?, ?, 'T', ?, ?)",
    )
    .run(id, PROJECT_ID, objectId, `a${id}`, CONVENOR, sourceUrl);
}

function addStep(id: number, storyId: number, objectId: string): void {
  memory.raw
    .prepare("INSERT INTO steps (id, story_id, step_number, order_key, kind, object_id) VALUES (?, ?, ?, ?, 'media', ?)")
    .run(id, storyId, id, `s${id}`, objectId);
}

async function load(objectId: string) {
  return (await loader({
    request: new Request(`https://compositor.telar.org/objects/${objectId}`),
    context: context(),
    params: { objectId },
  } as never)) as {
    manifestUrl: string | null;
    infoJsonUrl: string | null;
    usedInStories: Array<{ storyTitle: string | null; stepNumber: number }>;
  };
}

async function deleteFromRepo(objectDbId: number, objectId: string) {
  const form = new URLSearchParams({ intent: "delete-object", objectDbId: String(objectDbId), fromRepo: "true" });
  return action({
    request: new Request(`https://compositor.telar.org/objects/${objectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: context(),
    params: { objectId },
  } as never);
}

/** The paths the one delete commit removed. */
function deletedPaths(): string[] {
  const call = vi.mocked(commitFilesToRepo).mock.calls[0] as unknown[] | undefined;
  return ((call?.[7] as string[] | undefined) ?? []).slice().sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${CONVENOR}, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, ${CONVENOR}, 'owner/repo', 5)`,
  );
  memory.raw.exec(
    `INSERT INTO project_config (project_id, url, baseurl, telar_version) VALUES (${PROJECT_ID}, 'https://example.org', '/site', '1.7.0')`,
  );
  memory.raw.exec(`INSERT INTO project_members (project_id, user_id, role) VALUES (${PROJECT_ID}, ${CONVENOR}, 'convenor')`);
  memory.raw.exec(
    `INSERT INTO stories (id, project_id, story_id, title, "order", order_key) VALUES (1, ${PROJECT_ID}, 's1', 'The story', 0, 'a1')`,
  );
  vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5 },
    userRole: "convenor",
  } as never);
  treePaths = ["telar-content/objects/map.jpg"];
  sheet = "object_id,title\nmap.jpg,Map\n";
  repoConfig = null;
});

afterEach(() => {
  memory.close();
});

describe("the object's page", () => {
  it("reads a self-hosted map.jpg's manifest and info.json under map", async () => {
    addObject(10, "map.jpg");
    const data = await load("map.jpg");
    expect(data.manifestUrl).toBe(`${BASE}/iiif/objects/map/manifest.json`);
    expect(data.infoJsonUrl).toBe(`${BASE}/iiif/objects/map/info.json`);
  });

  it("keeps an external map.jpg's own manifest", async () => {
    addObject(10, "map.jpg", "https://iiif.example.org/map.jpg/manifest.json");
    const data = await load("map.jpg");
    expect(data.manifestUrl).toBe("https://iiif.example.org/map.jpg/manifest.json");
    expect(data.infoJsonUrl).toBeNull();
  });

  it("lists a step naming map among map.jpg's uses", async () => {
    addObject(10, "map.jpg");
    addStep(3, 1, "map");
    const data = await load("map.jpg");
    expect(data.usedInStories).toEqual([{ storyTitle: "The story", stepNumber: 3 }]);
  });
});

describe("deleting the object from the repository", () => {
  it("removes the file map.jpg the site found for the row map.jpg", async () => {
    addObject(10, "map.jpg");
    await deleteFromRepo(10, "map.jpg");
    expect(deletedPaths()).toEqual(["telar-content/objects/map.jpg"]);
  });

  it("keeps the file when a row map reads as the same object", async () => {
    addObject(10, "map.jpg");
    addObject(11, "map");
    sheet = "object_id,title\nmap,Map\nmap.jpg,Map\n";
    await deleteFromRepo(10, "map.jpg");
    expect(deletedPaths()).toEqual([]);
  });

  it("keeps the file map.jpg when the row map is deleted while map.jpg reads as the same object", async () => {
    addObject(10, "map.jpg");
    addObject(11, "map");
    sheet = "object_id,title\nmap,Map\nmap.jpg,Map\n";
    await deleteFromRepo(11, "map");
    expect(deletedPaths()).toEqual([]);
  });

  it("keeps map.jpg when map is deleted beside map.heic on a site the repository says is 1.8.0", async () => {
    addObject(10, "map.heic");
    addObject(11, "map");
    sheet = "object_id,title\nmap,Map\nmap.heic,Map\n";
    repoConfig = "title: T\ntelar:\n  version: 1.8.0\n";
    await deleteFromRepo(11, "map");
    expect(deletedPaths()).toEqual([]);
  });

  it("reads a flow-mapping telar: {version: 1.8.0} as the repository's version, over D1's 1.7.0", async () => {
    addObject(10, "map.heic");
    addObject(11, "map");
    sheet = "object_id,title\nmap,Map\nmap.heic,Map\n";
    repoConfig = "title: T\ntelar: {version: 1.8.0}\n";
    await deleteFromRepo(11, "map");
    expect(deletedPaths()).toEqual([]);
  });

  it("still removes the row map's own file when no other row reads as map", async () => {
    addObject(11, "map");
    sheet = "object_id,title\nmap,Map\n";
    await deleteFromRepo(11, "map");
    expect(deletedPaths()).toEqual(["telar-content/objects/map.jpg"]);
  });
});
