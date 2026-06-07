/**
 * Route-loader redirect coverage.
 *
 * Covers:
 *   - home.tsx ("/") redirects to /start (reversing the earlier /objects
 *     landing)
 *   - /homepage redirects to /pages/index
 *   - a collaborator hitting /publish redirects to /objects?denied=publish
 *     and /upgrade redirects to /objects?denied=upgrade
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared .server mocks (hoisted so they precede the route-module imports).
// The _app and _app.homepage loaders pull in a large server dependency chain;
// we stub each so the modules import cleanly and the loaders can run far
// enough to reach (or fail to reach) their redirect.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  resolveActiveProject: vi.fn(),
  getUserRole: vi.fn(),
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
          orderBy: vi.fn(async () => []),
        })),
      })),
    })),
  })),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => ""),
  })),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: mocks.resolveActiveProject,
  requireProjectMember: vi.fn(),
  getUserRole: mocks.getUserRole,
  getPresenceColor: vi.fn(async () => null),
}));

function makeContext(userId: number | null) {
  return {
    get: () => (userId === null ? null : { id: userId, github_login: "tester" }),
    cloudflare: {
      env: { DB: {}, SESSION_SECRET: "s", ENCRYPTION_KEY: "k" },
    },
  } as unknown as Parameters<never>[0];
}

/** Run a loader and capture a thrown Response (the redirect). */
async function captureRedirect(
  loader: (a: unknown) => unknown,
  arg: unknown,
): Promise<Response | null> {
  try {
    await loader(arg);
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// "/" → /start (reverses the earlier /objects landing)
// ---------------------------------------------------------------------------
describe("home.tsx index redirect", () => {
  it("redirects to /start", async () => {
    const { loader } = await import("../app/routes/home");
    const res = await captureRedirect(loader as never, undefined);
    expect(res).not.toBeNull();
    expect(res!.status).toBeGreaterThanOrEqual(300);
    expect(res!.status).toBeLessThan(400);
    expect(res!.headers.get("Location")).toBe("/start");
  });
});

// ---------------------------------------------------------------------------
// Regression guard: a zero-project user must NOT be bounced to /dashboard.
// /dashboard now redirects to /objects, so a no-project /objects loader that
// fell back to /dashboard produced an infinite /objects→/dashboard→/objects
// loop. The fallback must be /onboarding.
// ---------------------------------------------------------------------------
describe("zero-project redirect guard (no /dashboard loop)", () => {
  it("/objects with no active project redirects to /onboarding, not /dashboard", async () => {
    mocks.resolveActiveProject.mockResolvedValue(null);
    const { loader } = await import("../app/routes/_app.objects");
    // The objects loader *returns* the redirect (others throw) — handle both.
    let res: Response | null = null;
    try {
      const out = await (loader as (a: unknown) => unknown)({
        request: new Request("https://example.workers.dev/objects"),
        context: makeContext(7),
      });
      if (out instanceof Response) res = out;
    } catch (thrown) {
      if (thrown instanceof Response) res = thrown;
      else throw thrown;
    }
    expect(res).not.toBeNull();
    expect(res!.headers.get("Location")).toBe("/onboarding");
  });
});

// ---------------------------------------------------------------------------
// /homepage → /pages/index
// ---------------------------------------------------------------------------
describe("/homepage redirect", () => {
  it("redirects a resolved project to /pages/index", async () => {
    mocks.resolveActiveProject.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site" },
    });
    const { loader } = await import("../app/routes/_app.homepage");
    const res = await captureRedirect(loader as never, {
      request: new Request("https://example.workers.dev/homepage"),
      context: makeContext(7),
    });
    expect(res).not.toBeNull();
    expect(res!.headers.get("Location")).toBe("/pages/index");
  });
});

// ---------------------------------------------------------------------------
// collaborator hitting /publish or /upgrade is redirected with ?denied=
// ---------------------------------------------------------------------------
describe("collaborator gated-route guard", () => {
  it("redirects a collaborator on /publish to /objects?denied=publish", async () => {
    mocks.getUserRole.mockResolvedValue("collaborator");
    mocks.resolveActiveProject.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site" },
    });
    const { loader } = await import("../app/routes/_app");
    const res = await captureRedirect(loader as never, {
      request: new Request("https://example.workers.dev/publish"),
      context: makeContext(7),
    });
    expect(res).not.toBeNull();
    expect(res!.headers.get("Location")).toBe("/objects?denied=publish");
  });

  it("redirects a collaborator on /upgrade to /objects?denied=upgrade", async () => {
    mocks.getUserRole.mockResolvedValue("collaborator");
    mocks.resolveActiveProject.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site" },
    });
    const { loader } = await import("../app/routes/_app");
    const res = await captureRedirect(loader as never, {
      request: new Request("https://example.workers.dev/upgrade"),
      context: makeContext(7),
    });
    expect(res).not.toBeNull();
    expect(res!.headers.get("Location")).toBe("/objects?denied=upgrade");
  });
});
