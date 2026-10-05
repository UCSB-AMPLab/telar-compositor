/**
 * The objects page reads its objects as the site does.
 *
 * A self-hosted row written `map.jpg` has its image in the file `map.jpg`
 * (the site tiles it as `map`), a step naming `map` is one of its uses, and
 * two rows the site reads as one object — `map` and `map.jpg` — each say so.
 * The page needs the site's framework version for all three.
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

let memory: MemoryD1;
let treePaths: string[] = [];
/** The repository's `_config.yml`, or null for none. */
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
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
  siteChangedAnswer: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
  getInstallationInfo: vi.fn(),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(async () => ({
    tree: treePaths.map((path) => ({ path, mode: "100644", type: "blob", sha: "x" })),
    truncated: false,
  })),
  getRepoHead: vi.fn(),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
    path === "_config.yml" && repoConfig !== null ? { status: "ok", content: repoConfig } : { status: "absent" },
  ),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn(async () => ({ ok: false })) }));
vi.mock("~/lib/page-site-gate.server", () => ({ gatePageSite: vi.fn() }));
vi.mock("~/lib/github-status.server", () => ({
  bumpObjectsReadFrom: vi.fn(async () => true),
  bumpProjectHeadFrom: vi.fn(async () => true),
}));
vi.mock("~/lib/sync.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  computeSyncDiff: vi.fn(async () => ({
    newObjects: [{ object_id: "x" }], changedObjects: [], missingObjects: [], unregisteredFiles: [], headSha: "h",
  })),
  applySyncChanges: vi.fn(async () => ({ appliedCount: 0, pendingObjects: [], updateSkipped: false, notAdded: [] })),
  refuseMovedObjectsBase: vi.fn(async () => {}),
}));

import { action, loader } from "~/routes/_app.objects";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { gatePageSite } from "~/lib/page-site-gate.server";
import { computeSyncDiff } from "~/lib/sync.server";

function context() {
  return {
    get: vi.fn(() => ({ id: CONVENOR, encrypted_access_token: "enc" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {}, GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "p" } },
  } as never;
}

function addObject(id: number, objectId: string, imageAvailable = false, sourceUrl: string | null = null): void {
  memory.raw
    .prepare(
      "INSERT INTO objects (id, project_id, object_id, order_key, title, image_available, source_url, thumbnail) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, PROJECT_ID, objectId, `a${id}`, `Title ${id}`, imageAvailable ? 1 : 0, sourceUrl, sourceUrl ? "t.jpg" : null);
}

function storedImageAvailable(): Array<[string, number]> {
  return (memory.raw.prepare("SELECT object_id, image_available FROM objects ORDER BY id").all() as Array<{
    object_id: string;
    image_available: number;
  }>).map((r) => [r.object_id, r.image_available]);
}

function addStep(id: number, objectId: string): void {
  memory.raw
    .prepare("INSERT INTO steps (id, story_id, step_number, order_key, kind, object_id) VALUES (?, 1, ?, ?, 'media', ?)")
    .run(id, id, `s${id}`, objectId);
}

async function load() {
  return (await loader({
    request: new Request("https://compositor.telar.org/objects"),
    context: context(),
    params: {},
  } as never)) as {
    objects: Array<{ object_id: string; image_available: boolean | null }>;
    objectStepCounts: Record<string, number>;
    sharedSiteIds: Record<string, { others: string[]; shown: string }>;
    frameworkVersion: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  memory.raw.exec(
    `INSERT INTO stories (id, project_id, story_id, title, "order", order_key) VALUES (1, ${PROJECT_ID}, 's1', 'S', 0, 'a1')`,
  );
  vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5 },
    userRole: "convenor",
  } as never);
  vi.mocked(gatePageSite).mockResolvedValue({
    refused: null,
    page: { project: { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5 }, userRole: "convenor" },
  } as never);
  treePaths = [];
  repoConfig = null;
});

afterEach(() => {
  memory.close();
});

describe("the objects page", () => {
  it("leaves a self-hosted row whose file is in the repository not ready, and writes nothing to D1", async () => {
    const { getRepoTree } = await import("~/lib/github.server");
    addObject(10, "map.jpg");
    treePaths = ["telar-content/objects/map.jpg"];
    const data = await load();
    expect(data.objects.map((o) => [o.object_id, Boolean(o.image_available)])).toEqual([["map.jpg", false]]);
    expect(storedImageAvailable()).toEqual([["map.jpg", 0]]);
    expect(getRepoTree).not.toHaveBeenCalled();
  });

  it("leaves a row marked as having an image as it is", async () => {
    addObject(10, "Map", true);
    addObject(11, "other");
    treePaths = ["telar-content/objects/map.jpg"];
    const data = await load();
    expect(data.objects.map((o) => [o.object_id, Boolean(o.image_available)])).toEqual([["Map", true], ["other", false]]);
    expect(storedImageAvailable()).toEqual([["Map", 1], ["other", 0]]);
  });

  it("leaves an object with an external source as having an image", async () => {
    addObject(10, "far", true, "https://example.org/iiif/manifest.json");
    addObject(11, "other");
    const data = await load();
    expect(data.objects.map((o) => [o.object_id, Boolean(o.image_available)])).toEqual([["far", true], ["other", false]]);
  });

  it("counts a step naming map as a use of map.jpg", async () => {
    addObject(10, "map.jpg");
    addStep(3, "map");
    addStep(4, "map.jpg");
    const data = await load();
    expect(data.objectStepCounts).toEqual({ "map.jpg": 2 });
  });

  it("names, on each of map and map.jpg, the other and the row the site shows", async () => {
    addObject(10, "map");
    addObject(11, "map.jpg");
    addObject(12, "colonial");
    const data = await load();
    expect(data.sharedSiteIds).toEqual({
      map: { others: ["map.jpg"], shown: "map.jpg" },
      "map.jpg": { others: ["map"], shown: "map.jpg" },
    });
  });

  it("gives the page the site's framework version", async () => {
    const data = await load();
    expect(data.frameworkVersion).toBe("1.7.0");
  });
});

describe("the objects sync, from the objects page", () => {
  async function post(fields: Record<string, string>) {
    return action({
      request: new Request("https://compositor.telar.org/objects", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
      context: context(),
      params: {},
    } as never);
  }

  it("checks the repository on the site's framework version", async () => {
    await post({ intent: "compute-sync-diff" });
    expect(vi.mocked(computeSyncDiff).mock.calls[0][8]).toEqual({ d1: "1.7.0" });
  });
});

describe("the tile probe, from the objects page", () => {
  async function postTileProbe(objectIds: unknown) {
    return action({
      request: new Request("https://compositor.telar.org/objects", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "probe-tiles", objectIds: JSON.stringify(objectIds) }).toString(),
      }),
      context: context(),
      params: {},
    } as never);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the site the project's config names, under the site ids, and writes nothing to D1", async () => {
    addObject(10, "map.jpg");
    addObject(11, "plan");
    const fetchMock = vi.fn(async (url: string) =>
      new Response(null, { status: url === "https://example.org/site/iiif/objects/map/info.json" ? 200 : 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await postTileProbe(["map.jpg", "plan"])).toEqual({ ok: true, intent: "probe-tiles", site: "https://example.org/site", ready: ["map.jpg"], notFound: ["plan"] });
    expect(storedImageAvailable()).toEqual([["map.jpg", 0], ["plan", 0]]);
  });

  it("asks under the id the repository's 1.8.0 gives, not D1's 1.7.0", async () => {
    repoConfig = "title: T\ntelar:\n  version: 1.8.0\n";
    const fetchMock = vi.fn(async (url: string) =>
      new Response(null, { status: url === "https://example.org/site/iiif/objects/map/info.json" ? 200 : 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await postTileProbe(["map.heic"])).toEqual({ ok: true, intent: "probe-tiles", site: "https://example.org/site", ready: ["map.heic"], notFound: [] });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://example.org/site/iiif/objects/map/info.json"]);
  });

  it("asks under D1's version when the repository's _config.yml cannot be read", async () => {
    const { getFileAtRef } = await import("~/lib/github.server");
    vi.mocked(getFileAtRef).mockResolvedValueOnce({ status: "error" } as never);
    memory.raw.exec(`UPDATE project_config SET telar_version = '1.8.0' WHERE project_id = ${PROJECT_ID}`);
    const fetchMock = vi.fn(async (url: string) =>
      new Response(null, { status: url === "https://example.org/site/iiif/objects/map/info.json" ? 200 : 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await postTileProbe(["map.heic"])).toEqual({ ok: true, intent: "probe-tiles", site: "https://example.org/site", ready: ["map.heic"], notFound: [] });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://example.org/site/iiif/objects/map/info.json"]);
  });

  it("answers nothing ready for a list it cannot read", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postTileProbe({ not: "a list" })).toEqual({ ok: true, intent: "probe-tiles", site: null, ready: [], notFound: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks only about the entries of the list that are ids", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    expect(await postTileProbe([42, null, "map"])).toEqual({ ok: true, intent: "probe-tiles", site: "https://example.org/site", ready: ["map"], notFound: [] });
  });
});

// A site whose config names no address the probe may ask has nothing to probe,
// so its objects are read from the repository as the tiler reads it.
describe("the tile probe on a site with no address to ask", () => {
  async function postTreeProbe(objectIds: string[]) {
    return action({
      request: new Request("https://compositor.telar.org/objects", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "probe-tiles", objectIds: JSON.stringify(objectIds) }).toString(),
      }),
      context: context(),
      params: {},
    } as never);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers ready an object whose file is in the repository when the config names no url", async () => {
    memory.raw.exec(`UPDATE project_config SET url = NULL WHERE project_id = ${PROJECT_ID}`);
    addObject(10, "map.jpg");
    addObject(11, "plan");
    treePaths = ["telar-content/objects/map.jpg"];
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postTreeProbe(["map.jpg", "plan"])).toEqual({ ok: true, intent: "probe-tiles", site: null, ready: ["map.jpg"], notFound: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedImageAvailable()).toEqual([["map.jpg", 0], ["plan", 0]]);
  });

  it("answers by the repository when the config's url is not one the probe may ask", async () => {
    memory.raw.exec(`UPDATE project_config SET url = 'http://example.org' WHERE project_id = ${PROJECT_ID}`);
    treePaths = ["telar-content/objects/map.jpg"];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    expect(await postTreeProbe(["map.jpg"])).toEqual({ ok: true, intent: "probe-tiles", site: null, ready: ["map.jpg"], notFound: [] });
  });

  it("takes the repository's version for the file, as the tiler does", async () => {
    memory.raw.exec(`UPDATE project_config SET url = NULL WHERE project_id = ${PROJECT_ID}`);
    treePaths = ["telar-content/objects/map.jpg"];
    repoConfig = "title: T\ntelar:\n  version: 1.8.0\n";
    expect(await postTreeProbe(["map.heic"])).toEqual({ ok: true, intent: "probe-tiles", site: null, ready: ["map.heic"], notFound: [] });
  });

  it("does not take the file alone as ready when the site has an address to ask", async () => {
    treePaths = ["telar-content/objects/map.jpg"];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    expect(await postTreeProbe(["map.jpg"])).toEqual({ ok: true, intent: "probe-tiles", site: "https://example.org/site", ready: [], notFound: ["map.jpg"] });
  });
});
