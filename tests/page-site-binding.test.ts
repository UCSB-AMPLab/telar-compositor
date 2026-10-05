/**
 * Every write acts on the site the page showed.
 *
 * The session names one active site for the whole browser, and another tab
 * can change it. Each intent of each route action below is bound one of three
 * ways:
 *
 * - `site`: acts on the session's site, and only when the page posted that
 *   same site as `siteId` (`resolvePageProject`). A missing or different
 *   `siteId` answers 409 `site_changed` and writes nothing.
 * - `row`: names a row, and acts on that row's own site after checking the
 *   caller's standing there. The session is not consulted.
 * - `exempt`: acts on no site, on a site the form names and the action
 *   verifies, or keeps a comparison of its own.
 *
 * The table is checked against the source two ways (both are text checks and
 * are labelled so): it names every intent label in each action, and each
 * route's `PAGE_SITE_EXEMPT` list is exactly the table's non-`site` intents.
 * The behavioural tests then run every `site` intent with a mismatched and a
 * missing `siteId`, and every `row` intent from a tab whose session names
 * another site.
 *
 * @version v1.5.0-beta
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** The site the session names. */
const SESSION_SITE = 42;
/** The site the page showed, which another tab switched away from. */
const PAGE_SITE = 11;
const USER_ID = 3;

const state = vi.hoisted(() => ({
  dbCalls: [] as string[],
  selectQueue: [] as unknown[][],
  updates: [] as Array<{ table: unknown; set: unknown; where: unknown }>,
  roles: new Map<number, string>(),
}));

function builder(result: unknown[]) {
  const p = Promise.resolve(result);
  const b: Record<string, unknown> = {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
  };
  for (const m of ["from", "where", "limit", "innerJoin", "leftJoin", "orderBy", "groupBy"]) {
    b[m] = () => b;
  }
  return b;
}

const db = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === "then") return undefined;
      return (...args: unknown[]) => {
        state.dbCalls.push(String(key));
        if (key === "select") return builder(state.selectQueue.shift() ?? []);
        if (key === "update") {
          const table = args[0];
          return {
            set: (set: unknown) => ({
              where: (where: unknown) => {
                state.updates.push({ table, set, where });
                return Promise.resolve({});
              },
            }),
          };
        }
        return builder([]);
      };
    },
  },
);

vi.mock("~/lib/db.server", () => ({ getDb: () => db }));

vi.mock("~/middleware/auth.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSessionStorage: () => ({
    getSession: async () => ({
      get: (key: string) =>
        key === "activeProjectId" ? SESSION_SITE : key === "userId" ? USER_ID : undefined,
      set: () => {},
    }),
    commitSession: async () => "session=1",
  }),
}));

vi.mock("~/lib/membership.server", async (importOriginal) => {
  const forbidden = () => new Response("Forbidden", { status: 403 });
  return {
    ...(await importOriginal<object>()),
    resolveActiveProject: vi.fn(async () => ({
      project: {
        id: SESSION_SITE,
        kind: "site",
        parent_project_id: null,
        github_repo_full_name: "owner/session-site",
        installation_id: 1,
        head_sha: null,
      },
      userRole: "convenor",
    })),
    getUserRole: vi.fn(async (_db: unknown, projectId: number) => state.roles.get(projectId) ?? null),
    requireProjectMember: vi.fn(async (_db: unknown, projectId: number) => {
      if (!state.roles.has(projectId)) throw forbidden();
    }),
    requireOwner: vi.fn(async (_db: unknown, projectId: number) => {
      if (state.roles.get(projectId) !== "convenor") throw forbidden();
    }),
  };
});

vi.mock("~/lib/operation-lease.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  holdOperationLease: vi.fn(async () => ({ refused: true })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action as dashboardAction } from "~/routes/_app.dashboard";
import { action as configAction } from "~/routes/_app.config";
import { action as courseAction } from "~/routes/_app.course";
import { action as objectsAction } from "~/routes/_app.objects";
import { action as objectDetailAction } from "~/routes/_app.objects.$objectId";
import { action as pagesAction } from "~/routes/_app.pages";
import { action as publishAction } from "~/routes/_app.publish";
import { action as storiesAction } from "~/routes/_app.stories";
import { action as upgradeAction } from "~/routes/_app.upgrade";
import { action as welcomeAckAction } from "~/routes/api.welcome-ack";
import { holdOperationLease } from "~/lib/operation-lease.server";
import { requireOwner, requireProjectMember } from "~/lib/membership.server";

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type Binding = "site" | "row" | "exempt";

/** `""` is the submit that carries no intent (the config save, the welcome ack). */
const TABLE: Record<string, Record<string, Binding>> = {
  "_app.dashboard.tsx": {
    "switch-project": "exempt",
    "generate-invite": "site",
    "search-users": "site",
    "send-invite": "site",
    "cancel-invite": "row",
    "create-code": "exempt",
    "revoke-code": "exempt",
    "remove-member": "site",
    "compute-full-sync-diff": "site",
    "apply-full-sync": "site",
    "accept-divergence": "site",
    "choose-columns": "site",
    "restore-orphan-drafts": "site",
    "ignore-orphans": "site",
  },
  "_app.config.tsx": {
    "": "site",
    "refresh-themes": "site",
    "join-course": "site",
    "leave-course": "site",
  },
  "_app.course.tsx": {
    "remove-site": "site",
  },
  "_app.objects.tsx": {
    "toggle-featured": "row",
    "compute-sync-diff": "site",
    "sync-apply": "site",
    "fetch-iiif-preview": "exempt",
    "upload-image": "site",
    "pre-commit-check": "site",
    "commit-objects": "site",
    "poll-build": "site",
    "probe-tiles": "site",
    "enrich-external": "site",
    "complete-pending-objects": "site",
    "insert-pending-objects": "exempt",
  },
  "_app.objects.$objectId.tsx": {
    "autosave-object-featured": "row",
    "delete-object": "row",
    "rename-object": "row",
    "poll-build": "site",
    "dispatch-iiif": "site",
  },
  "_app.pages.tsx": {
    "autosave-page-body": "row",
    "scan-repo-pages": "site",
    "import-pages": "site",
  },
  "_app.publish.tsx": {
    "run-validation": "site",
    publish: "site",
    "poll-build": "site",
    "dismiss-intro": "site",
    "repair-build-workflow": "site",
  },
  "_app.stories.tsx": {
    "toggle-draft": "row",
    "toggle-private": "row",
    "flush-yjs-snapshot": "site",
  },
  "_app.upgrade.tsx": {
    "upgrade-prepare": "site",
    "upgrade-commit": "site",
    "upgrade-cancel": "site",
    "poll-build": "site",
    rebuild: "site",
    "compute-diff": "site",
  },
  // The form names the site the modal showed; the stamp touches only the
  // caller's own membership of it.
  "api.welcome-ack.tsx": {
    "": "row",
  },
  // Every intent here takes its site from the step, layer or story row it
  // names and checks membership there.
  "_app.stories.$storyId.tsx": {
    "capture-position": "row",
    "change-object": "row",
    "set-page": "row",
    "save-layer": "row",
    "autosave-layer": "row",
    "save-step-field": "row",
  },
};

const ROUTES_DIR = join(__dirname, "..", "app", "routes");

function actionBody(file: string): string {
  const src = readFileSync(join(ROUTES_DIR, file), "utf8");
  const start = src.indexOf("export async function action(");
  if (start < 0) throw new Error(`${file} has no action`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

// Text check: the labels an action's own source dispatches on. Blind to an
// intent read any other way, which is why the behavioural tests below exist.
function intentLabels(body: string): Set<string> {
  const labels = new Set<string>();
  for (const m of body.matchAll(/case "([^"]+)":/g)) labels.add(m[1]);
  for (const m of body.matchAll(/intent [!=]== "([^"]+)"/g)) labels.add(m[1]);
  for (const m of body.matchAll(/formData\.get\("intent"\) [!=]== "([^"]+)"/g)) labels.add(m[1]);
  return labels;
}

describe("the intent table (text check)", () => {
  for (const [file, intents] of Object.entries(TABLE)) {
    it(`names every intent label in ${file}'s action`, () => {
      const labels = intentLabels(actionBody(file));
      const named = new Set(Object.keys(intents).filter((i) => i !== ""));
      expect([...labels].filter((l) => !named.has(l)).sort()).toEqual([]);
      expect([...named].filter((n) => !labels.has(n)).sort()).toEqual([]);
    });
  }

  for (const [file, intents] of Object.entries(TABLE)) {
    const body = actionBody(file);
    const exemptList = body.match(/const PAGE_SITE_EXEMPT = \[([^\]]*)\]/);
    if (!exemptList) continue;
    it(`${file}'s PAGE_SITE_EXEMPT is the table's non-site intents`, () => {
      const listed = [...exemptList[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
      const expected = Object.entries(intents)
        .filter(([, b]) => b !== "site")
        .map(([i]) => i)
        .sort();
      expect(listed).toEqual(expected);
    });
  }

  it("every site-level action calls resolvePageProject or gatePageSite", () => {
    for (const [file, intents] of Object.entries(TABLE)) {
      if (!Object.values(intents).includes("site")) continue;
      expect(actionBody(file), file).toMatch(/\b(resolvePageProject|gatePageSite)\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const collaborationGet = vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}")) }));

function env() {
  return {
    SESSION_SECRET: "sess-secret",
    ENCRYPTION_KEY: "key",
    DB: {},
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
    COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: collaborationGet },
  };
}

function context() {
  const user = {
    id: USER_ID,
    encrypted_access_token: "enc",
    github_login: "author",
    course_access: true,
  };
  return { get: () => user, cloudflare: { env: env() } };
}

function post(path: string, fields: Record<string, string>): Request {
  return new Request(`https://compositor.telar.org${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

type ActionFn = (args: never) => Promise<unknown>;

const ROUTE_ACTIONS: Record<string, { action: ActionFn; path: string; params?: Record<string, string> }> = {
  "_app.dashboard.tsx": { action: dashboardAction as ActionFn, path: "/dashboard" },
  "_app.config.tsx": { action: configAction as ActionFn, path: "/config" },
  "_app.course.tsx": { action: courseAction as ActionFn, path: "/course" },
  "_app.objects.tsx": { action: objectsAction as ActionFn, path: "/objects" },
  "_app.objects.$objectId.tsx": {
    action: objectDetailAction as ActionFn,
    path: "/objects/obj-1",
    params: { objectId: "obj-1" },
  },
  "_app.pages.tsx": { action: pagesAction as ActionFn, path: "/pages" },
  "_app.publish.tsx": { action: publishAction as ActionFn, path: "/publish" },
  "_app.stories.tsx": { action: storiesAction as ActionFn, path: "/stories" },
  "_app.upgrade.tsx": { action: upgradeAction as ActionFn, path: "/upgrade" },
  "api.welcome-ack.tsx": { action: welcomeAckAction as ActionFn, path: "/api/welcome-ack" },
};

async function run(file: string, fields: Record<string, string>): Promise<unknown> {
  const route = ROUTE_ACTIONS[file];
  return route.action({
    request: post(route.path, fields),
    context: context(),
    params: route.params ?? {},
  } as never);
}

interface Refusal {
  data: { ok: boolean; error: string; intent: string; currentSiteName: string };
  init: { status: number } | null;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  state.dbCalls.length = 0;
  state.selectQueue.length = 0;
  state.updates.length = 0;
  state.roles.clear();
  state.roles.set(SESSION_SITE, "convenor");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("no network in this test");
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Rule 2: a site-level write refuses a page that showed another site
// ---------------------------------------------------------------------------

describe("site-level intents refuse a page that showed another site", () => {
  for (const [file, intents] of Object.entries(TABLE)) {
    if (!(file in ROUTE_ACTIONS)) continue;
    for (const [intent, binding] of Object.entries(intents)) {
      if (binding !== "site") continue;
      const base: Record<string, string> = intent === "" ? {} : { intent };
      const variants: Array<[string, Record<string, string>]> = [
        ["a mismatched siteId", { siteId: String(PAGE_SITE) }],
        ["no siteId", {}],
      ];
      for (const [label, extra] of variants) {
        it(`${file} ${intent || "(no intent)"}: ${label} answers 409 site_changed and writes nothing`, async () => {
          const res = (await run(file, { ...base, ...extra })) as Refusal;
          expect(res.init?.status).toBe(409);
          expect(res.data).toMatchObject({
            ok: false,
            error: "site_changed",
            currentSiteName: "owner/session-site",
          });
          expect(state.dbCalls).toEqual([]);
          expect(collaborationGet).not.toHaveBeenCalled();
          expect(fetchSpy).not.toHaveBeenCalled();
        });
      }
    }
  }

  it("the check admits the matching siteId (a mutation of the comparison fails here)", async () => {
    const res = (await run("_app.stories.tsx", {
      intent: "flush-yjs-snapshot",
      siteId: String(SESSION_SITE),
    })) as { ok: boolean; intent: string };
    expect(res).toMatchObject({ intent: "flush-yjs-snapshot" });
    expect(collaborationGet).toHaveBeenCalled();
  });

  it("insert-pending-objects answers site_changed when the commit's site is not the session's", async () => {
    const res = (await run("_app.objects.tsx", {
      intent: "insert-pending-objects",
      operationId: "1",
      projectId: String(PAGE_SITE),
    })) as Refusal;
    expect(res.init?.status).toBe(409);
    expect(res.data).toMatchObject({ error: "site_changed", intent: "insert-pending-objects" });
    expect(holdOperationLease).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rule 1: a row-level write acts on the row's own site
// ---------------------------------------------------------------------------

/** Walks a drizzle SQL tree for a bound number. */
function clauseHas(node: unknown, value: number, seen = new Set<unknown>()): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node === "number") return node === value;
  if (typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  const obj = node as Record<string, unknown>;
  if (obj.value === value) return true;
  if (Array.isArray(obj.queryChunks)) {
    for (const chunk of obj.queryChunks) if (clauseHas(chunk, value, seen)) return true;
  }
  return false;
}

interface RowCase {
  file: string;
  intent: string;
  fields: Record<string, string>;
  /** The rows the action's selects read, in order. */
  rows: unknown[][];
  /** The gate that checks standing on the row's site. */
  gate: () => ReturnType<typeof vi.fn>;
  /** The role the gate requires. */
  role: string;
  /** Whether the update's WHERE carries the row's site. */
  scopedWhere: boolean;
}

const ROW_CASES: RowCase[] = [
  {
    file: "_app.dashboard.tsx",
    intent: "cancel-invite",
    fields: { inviteId: "5" },
    rows: [[{ project_id: PAGE_SITE }]],
    gate: () => vi.mocked(requireOwner),
    role: "convenor",
    scopedWhere: true,
  },
  {
    file: "_app.objects.tsx",
    intent: "toggle-featured",
    fields: { objectDbId: "5", currentValue: "false" },
    rows: [[{ project_id: PAGE_SITE }]],
    gate: () => vi.mocked(requireProjectMember),
    role: "collaborator",
    scopedWhere: true,
  },
  {
    file: "_app.objects.$objectId.tsx",
    intent: "autosave-object-featured",
    fields: { entityId: "5", value: "true" },
    rows: [[{ project_id: PAGE_SITE }]],
    gate: () => vi.mocked(requireProjectMember),
    role: "collaborator",
    scopedWhere: true,
  },
  {
    file: "_app.pages.tsx",
    intent: "autosave-page-body",
    fields: { projectId: "5", value: "Body" },
    rows: [[{ id: 5, project_id: PAGE_SITE }]],
    gate: () => vi.mocked(requireProjectMember),
    role: "collaborator",
    scopedWhere: false,
  },
  {
    file: "_app.stories.tsx",
    intent: "toggle-draft",
    fields: { storyDbId: "5", currentValue: "false" },
    rows: [[{ project_id: PAGE_SITE }]],
    gate: () => vi.mocked(requireProjectMember),
    role: "collaborator",
    scopedWhere: true,
  },
  {
    file: "_app.stories.tsx",
    intent: "toggle-private",
    fields: { storyDbId: "5", currentValue: "false" },
    rows: [[{ project_id: PAGE_SITE }]],
    gate: () => vi.mocked(requireProjectMember),
    role: "collaborator",
    scopedWhere: true,
  },
];

describe("the welcome acknowledgement stamps the site the modal showed", () => {
  it("stamps the posted site's membership while the session names another", async () => {
    const res = await run("api.welcome-ack.tsx", { siteId: String(PAGE_SITE) });
    expect(res).toEqual({ ok: true });
    expect(state.updates).toHaveLength(1);
    expect(clauseHas(state.updates[0].where, PAGE_SITE)).toBe(true);
    expect(clauseHas(state.updates[0].where, SESSION_SITE)).toBe(false);
  });

  it("stamps nothing without a site", async () => {
    expect(await run("api.welcome-ack.tsx", {})).toEqual({ ok: false });
    expect(state.updates).toHaveLength(0);
  });
});

describe("row-level intents act on the row's own site", () => {
  for (const c of ROW_CASES) {
    it(`${c.file} ${c.intent}: a row on the page's site is written there while the session names another`, async () => {
      state.roles.set(PAGE_SITE, c.role);
      state.selectQueue.push(...c.rows);
      const res = await run(c.file, { intent: c.intent, ...c.fields });
      expect(res).toMatchObject({ ok: true, intent: c.intent });
      expect(c.gate()).toHaveBeenCalledWith(expect.anything(), PAGE_SITE, USER_ID);
      expect(state.updates).toHaveLength(1);
      if (c.scopedWhere) {
        expect(clauseHas(state.updates[0].where, PAGE_SITE)).toBe(true);
        expect(clauseHas(state.updates[0].where, SESSION_SITE)).toBe(false);
      }
    });

    it(`${c.file} ${c.intent}: a caller without standing on the row's site is refused and nothing is written`, async () => {
      state.selectQueue.push(...c.rows);
      const thrown = await run(c.file, { intent: c.intent, ...c.fields }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(403);
      expect(state.updates).toHaveLength(0);
    });
  }

  const target = {
    id: 5,
    project_id: PAGE_SITE,
    object_id: "obj-1",
    created_by: USER_ID,
    course_project_id: null,
    source_url: null,
  };
  const pageSiteRow = {
    id: PAGE_SITE,
    kind: "site",
    github_repo_full_name: "owner/page-site",
    installation_id: 1,
  };

  it("delete-object takes the lease on the object's own site while the session names another", async () => {
    state.roles.set(PAGE_SITE, "collaborator");
    state.selectQueue.push([target], [pageSiteRow]);
    const res = await run("_app.objects.$objectId.tsx", {
      intent: "delete-object",
      objectDbId: "5",
      fromRepo: "false",
    });
    expect(res).toMatchObject({ ok: false, error: "operation_in_progress", objectDbId: 5 });
    expect(vi.mocked(holdOperationLease).mock.calls[0]?.[1]).toBe(PAGE_SITE);
  });

  it("delete-object keeps the convenor requirement for the repository half on the object's site", async () => {
    state.roles.set(PAGE_SITE, "collaborator");
    state.selectQueue.push([target], [pageSiteRow]);
    const res = await run("_app.objects.$objectId.tsx", {
      intent: "delete-object",
      objectDbId: "5",
      fromRepo: "true",
    });
    expect(res).toMatchObject({ ok: false, error: "forbidden" });
    expect(holdOperationLease).not.toHaveBeenCalled();
  });

  it("rename-object takes the lease on the object's own site while the session names another", async () => {
    state.roles.set(PAGE_SITE, "collaborator");
    state.selectQueue.push([target], [pageSiteRow]);
    const res = await run("_app.objects.$objectId.tsx", {
      intent: "rename-object",
      objectDbId: "5",
      shownObjectId: "obj-1",
      newId: "obj-2",
    });
    expect(res).toMatchObject({ ok: false, error: "rename_operation_in_progress", objectDbId: 5 });
    expect(vi.mocked(holdOperationLease).mock.calls[0]?.[1]).toBe(PAGE_SITE);
  });

  it("rename-object sends a caller with no membership on the object's site back to the grid", async () => {
    state.selectQueue.push([target], [pageSiteRow]);
    const thrown = await run("_app.objects.$objectId.tsx", {
      intent: "rename-object",
      objectDbId: "5",
      shownObjectId: "obj-1",
      newId: "obj-2",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/objects");
    expect(holdOperationLease).not.toHaveBeenCalled();
  });

  it("delete-object sends a caller with no membership on the object's site back to the grid", async () => {
    state.selectQueue.push([target], [pageSiteRow]);
    const thrown = await run("_app.objects.$objectId.tsx", {
      intent: "delete-object",
      objectDbId: "5",
      fromRepo: "false",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/objects");
    expect(holdOperationLease).not.toHaveBeenCalled();
  });
});
