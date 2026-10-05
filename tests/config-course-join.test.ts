/**
 * This file pins the settings join and leave surface — the second place a
 * class code can be entered, and the only place a site leaves a course.
 *
 * `redeemForSite` and `applyRedemptionSideEffects` own the join and
 * `detachChildFromCourse` owns the whole leave sequence, so what is asserted
 * here is the route's part: that the child convenor is the only caller either
 * one runs for, that every redemption state survives to the page as its own
 * outcome, that the course a leave acts on is read from the parent link rather
 * than taken from the submission, and that a sequence which finishes on a site
 * that has left the course is not reported as a success.
 *
 * It also pins the repair path the wizard's failure message promises: a code
 * that did not take at creation reaches the same end state when it is entered
 * here, whether the attachment never happened or happened without its
 * collection.
 *
 * Mocking strategy mirrors `tests/config-action-authz.test.ts`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
// resolvePageProject and siteChangedAnswer are reimplemented here against the
// mocked resolveActiveProjectFromRequest, mirroring active-project.server.ts:
// a same-module call inside the real resolvePageProject binds to the real
// resolveActiveProjectFromRequest, not to a vi.fn() substituted only in this
// mock's returned object, so importOriginal would not let the mock take hold.
vi.mock("~/lib/active-project.server", async () => {
  const { data } = await import("react-router");
  const resolveActiveProjectFromRequest = vi.fn();
  return {
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(
      async (_request: Request, _env: unknown, _userId: number, formData: FormData) => {
        const resolved = await resolveActiveProjectFromRequest();
        if (!resolved) return { kind: "no_project" as const };
        if (formData.get("siteId") !== String((resolved as never as { project: { id: number } }).project.id)) {
          return {
            kind: "site_changed" as const,
            currentSiteName: (resolved as never as { project: { github_repo_full_name: string } })
              .project.github_repo_full_name,
          };
        }
        return { kind: "ok" as const, ...(resolved as object) };
      },
    ),
    siteChangedAnswer: vi.fn((intent: string, currentSiteName: string) =>
      data({ ok: false, intent, error: "site_changed", currentSiteName }, { status: 409 }),
    ),
  };
});
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(async () => ({ tree: [] })),
  getFileContent: vi.fn(async () => null),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/yaml.server", () => ({ parseYaml: vi.fn(() => ({})) }));
vi.mock("~/lib/sheets-reconcile.server", () => ({
  reconcileSheetsFlagFromRepo: vi.fn(),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ getYText: vi.fn() }));

vi.mock("~/lib/join-codes.server", () => ({ redeemForSite: vi.fn() }));
// The consequences are stubbed because this suite is about the route's own
// decisions; `courseDisplayName` is not, and takes its real implementation.
// The name it resolves IS one of those decisions here — two cases below assert
// which of the course's two names the line carries.
vi.mock("~/lib/course-membership.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/course-membership.server")>();
  return {
    courseDisplayName: actual.courseDisplayName,
    applyRedemptionSideEffects: vi.fn(),
    detachChildFromCourse: vi.fn(),
  };
});

import { action, loader } from "~/routes/_app.config";
import { courseSettingsMessage } from "~/components/features/onboarding/CourseJoinNotice";
import { getDb } from "~/lib/db.server";
import { project_config } from "~/db/schema";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { redeemForSite } from "~/lib/join-codes.server";
import {
  applyRedemptionSideEffects,
  detachChildFromCourse,
} from "~/lib/course-membership.server";

type Role = "convenor" | "collaborator" | "instructor";

const USER_ID = 7;
const CHILD_ID = 42;
const COURSE_ID = 900;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A select chain that answers by shape rather than by call order, so a test
 * that adds a query does not silently re-point an existing one: the joined
 * read is the leave gate, `project_config` is the course's title, and the
 * bare `projects` read is the repo-name fallback behind it.
 */
function makeDbMock() {
  const state = {
    /** What the leave gate reads: this caller's role and the site's parent. */
    parentAndRole: [{ parent: COURSE_ID as number | null, role: "convenor" as string }],
    courseTitle: [{ title: "History 101" }] as Array<{ title: string | null }>,
    courseRepo: [{ repo: "teacher/hist-101" }],
  };

  const select = vi.fn(() => {
    let table: unknown = null;
    let joined = false;
    const chain = {
      from: vi.fn((t: unknown) => {
        table = t;
        return chain;
      }),
      innerJoin: vi.fn(() => {
        joined = true;
        return chain;
      }),
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          if (joined) return state.parentAndRole;
          if (table === project_config) return state.courseTitle;
          return state.courseRepo;
        }),
      })),
    };
    return chain;
  });

  return {
    state,
    select,
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
}

let currentDb: ReturnType<typeof makeDbMock>;

function asRole(role: Role, project: Record<string, unknown> = {}) {
  vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
    project: {
      id: CHILD_ID,
      github_repo_full_name: "student/group-a",
      kind: "site",
      parent_project_id: null,
      ...project,
    },
    userRole: role,
  } as never);
}

function args(body: BodyInit) {
  return {
    request: new Request("https://compositor.telar.org/config", {
      method: "POST",
      body,
    }),
    context: {
      get: vi.fn(() => ({ id: USER_ID, encrypted_access_token: "enc-token" })),
      cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "s", DB: {} } },
    },
    params: {},
  } as never;
}

function post(fields: Record<string, string>) {
  const form = new URLSearchParams();
  // The active project every request must post against: asRole()'s CHILD_ID,
  // string-compared by resolvePageProject. Callers may override via `fields`.
  form.set("siteId", String(CHILD_ID));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action(
    args(form) as never,
  ) as Promise<{ intent?: string; outcome?: Record<string, unknown> | null }>;
}

/** What the side effects report when the collection transferred cleanly. */
const TRANSFERRED = {
  staff: { added: 2 },
  preload: {
    inserted: 12,
    skippedAlreadyOurs: [],
    skippedConflict: ["dup-1"],
    skippedRepoBound: ["repo-1", "repo-2"],
  },
  enrolled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDbMock();
  vi.mocked(getDb).mockReturnValue(currentDb as never);
  vi.mocked(applyRedemptionSideEffects).mockResolvedValue(TRANSFERRED as never);
  vi.mocked(detachChildFromCourse).mockResolvedValue({
    markersCleared: 12,
    instructorsDropped: [3, 4],
    admissionRecordsCleared: 1,
    detached: true,
    failedEvictionUsers: [],
  } as never);
  asRole("convenor");
});

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

describe("config action: a valid class code attaches the site", () => {
  beforeEach(() => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: COURSE_ID,
      inviteId: 5,
      alreadyAttached: false,
    } as never);
  });

  it("redeems the submitted code against this site, for this caller", async () => {
    await post({ intent: "join-course", course_code: "  H7K2N9QRST  " });

    expect(redeemForSite).toHaveBeenCalledWith(currentDb, {
      token: "H7K2N9QRST",
      childProjectId: CHILD_ID,
      userId: USER_ID,
    });
  });

  it("ignores a site id supplied by the submission", async () => {
    await post({
      intent: "join-course",
      course_code: "H7K2N9QRST",
      project_id: "999",
      child_project_id: "999",
    });

    expect(redeemForSite).toHaveBeenCalledWith(currentDb, {
      token: "H7K2N9QRST",
      childProjectId: CHILD_ID,
      userId: USER_ID,
    });
  });

  it("runs the redemption's side effects for the course it attached to", async () => {
    await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(applyRedemptionSideEffects).toHaveBeenCalledWith(
      currentDb,
      expect.anything(),
      { courseProjectId: COURSE_ID, childProjectId: CHILD_ID },
    );
  });

  it("reports the course by name and what its collection did", async () => {
    const result = await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(result.outcome).toEqual({
      state: "ok",
      courseProjectId: COURSE_ID,
      courseName: "History 101",
      alreadyAttached: false,
      preloaded: 12,
      skippedConflict: 1,
      skippedRepoBound: 2,
    });
  });

  it("falls back to the course's repository when its title is empty", async () => {
    currentDb.state.courseTitle = [{ title: "   " }];

    const result = await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(result.outcome).toMatchObject({ courseName: "teacher/hist-101" });
  });
});

describe("config action: every redemption refusal keeps its own name", () => {
  const REFUSALS = [
    "not_found",
    "expired",
    "revoked",
    "consumed",
    "wrong_kind",
    "rate_limited",
    "already_enrolled",
    "not_a_site",
  ] as const;

  it.each(REFUSALS)("reports %s as itself", async (state) => {
    vi.mocked(redeemForSite).mockResolvedValue({ state, kind: "site" } as never);

    const result = await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(result.outcome).toEqual({ state, kind: "site" });
  });

  it.each(REFUSALS)("runs no side effects after %s", async (state) => {
    vi.mocked(redeemForSite).mockResolvedValue({ state, kind: "site" } as never);

    await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(applyRedemptionSideEffects).not.toHaveBeenCalled();
  });

  it("gives each refusal its own sentence", () => {
    const keys = REFUSALS.map(
      (state) => courseSettingsMessage({ state, kind: "site" } as never)?.key,
    );
    expect(new Set(keys).size).toBe(REFUSALS.length);
    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
  });
});

describe("config action: the join is the child convenor's alone", () => {
  it.each(["collaborator", "instructor"] as const)("refuses a %s", async (role) => {
    asRole(role);

    const result = await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(result.outcome).toEqual({ state: "forbidden" });
    expect(redeemForSite).not.toHaveBeenCalled();
  });
});

describe("config action: nothing is redeemed without a code", () => {
  it("attempts no redemption for an empty field", async () => {
    const result = await post({ intent: "join-course", course_code: "   " });

    expect(result.outcome).toBeNull();
    expect(redeemForSite).not.toHaveBeenCalled();
  });

  it("attempts no redemption for a value that is not a string", async () => {
    const form = new FormData();
    form.set("intent", "join-course");
    form.set("siteId", String(CHILD_ID));
    form.set("course_code", new Blob(["H7K2N9QRST"]), "code.txt");

    const result = (await action(args(form) as never)) as {
      outcome?: Record<string, unknown> | null;
    };

    expect(result.outcome).toBeNull();
    expect(redeemForSite).not.toHaveBeenCalled();
  });
});

describe("config action: a code that failed at creation succeeds here", () => {
  it("re-runs the side effects on a site that is already attached", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: COURSE_ID,
      inviteId: 5,
      alreadyAttached: true,
    } as never);

    const result = await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(applyRedemptionSideEffects).toHaveBeenCalledWith(
      currentDb,
      expect.anything(),
      { courseProjectId: COURSE_ID, childProjectId: CHILD_ID },
    );
    expect(result.outcome).toMatchObject({
      state: "ok",
      alreadyAttached: true,
      preloaded: 12,
    });
  });

  it("reports a sequence that threw as a retryable error, not a success", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: COURSE_ID,
      inviteId: 5,
      alreadyAttached: false,
    } as never);
    vi.mocked(applyRedemptionSideEffects).mockRejectedValue(new Error("DO down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    // The intent rides on the outcome: a join that threw and a leave that
    // threw are repaired the same way but leave the site in opposite states,
    // so they cannot share a sentence.
    expect(result.outcome).toEqual({ state: "error", intent: "join" });
    const message = courseSettingsMessage({ state: "error", intent: "join" });
    expect(message?.tone).toBe("warning");
    expect(message?.key).toBe("config:course.join_failed");
    expect(courseSettingsMessage({ state: "error", intent: "leave" })?.key).toBe(
      "config:course.leave_failed",
    );
    logged.mockRestore();
  });
});

describe("config action: a site that left mid-sequence is not reported joined", () => {
  beforeEach(() => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: COURSE_ID,
      inviteId: 5,
      alreadyAttached: false,
    } as never);
    vi.mocked(applyRedemptionSideEffects).mockResolvedValue({
      staff: { added: 2 },
      preload: {
        inserted: 0,
        skippedAlreadyOurs: [],
        skippedConflict: [],
        skippedRepoBound: [],
      },
      enrolled: false,
    } as never);
  });

  it("reports not_enrolled rather than ok", async () => {
    const result = await post({ intent: "join-course", course_code: "H7K2N9QRST" });

    expect(result.outcome).toEqual({ state: "not_enrolled" });
  });

  it("renders it as a warning, and never as the join confirmation", () => {
    const message = courseSettingsMessage({ state: "not_enrolled" });

    expect(message?.tone).toBe("warning");
    expect(message?.key).not.toBe("onboarding:course_join.joined");
    expect(message?.details ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

describe("config action: leaving runs the detach sequence", () => {
  it("detaches from the course the parent link names", async () => {
    const result = await post({ intent: "leave-course" });

    expect(detachChildFromCourse).toHaveBeenCalledWith(currentDb, expect.anything(), {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });
    expect(result.outcome).toEqual({ state: "left" });
  });

  it("ignores a course id supplied by the submission", async () => {
    await post({ intent: "leave-course", course_project_id: "999", project_id: "999" });

    expect(detachChildFromCourse).toHaveBeenCalledWith(currentDb, expect.anything(), {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });
  });

  it("refuses a caller whose convenor row has gone since the page loaded", async () => {
    currentDb.state.parentAndRole = [{ parent: COURSE_ID, role: "collaborator" }];

    const result = await post({ intent: "leave-course" });

    expect(result.outcome).toEqual({ state: "forbidden" });
    expect(detachChildFromCourse).not.toHaveBeenCalled();
  });

  it("refuses a caller with no membership row at all", async () => {
    currentDb.state.parentAndRole = [];

    const result = await post({ intent: "leave-course" });

    expect(result.outcome).toEqual({ state: "forbidden" });
    expect(detachChildFromCourse).not.toHaveBeenCalled();
  });

  it.each(["collaborator", "instructor"] as const)("refuses a %s", async (role) => {
    asRole(role);

    const result = await post({ intent: "leave-course" });

    expect(result.outcome).toEqual({ state: "forbidden" });
    expect(detachChildFromCourse).not.toHaveBeenCalled();
  });

  it("detaches nothing when the site is already out of every course", async () => {
    currentDb.state.parentAndRole = [{ parent: null, role: "convenor" }];

    const result = await post({ intent: "leave-course" });

    expect(detachChildFromCourse).not.toHaveBeenCalled();
    expect(result.outcome).toEqual({ state: "left" });
  });

  it("reports a failed marker clear as an error, leaving the site enrolled", async () => {
    vi.mocked(detachChildFromCourse).mockRejectedValue(new Error("DO returned 500"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await post({ intent: "leave-course" });

    expect(result.outcome).toEqual({ state: "error", intent: "leave" });
    logged.mockRestore();
  });

  it("confirms a completed departure", () => {
    // This said nothing while the phase carried no copy for it, and the
    // re-rendered section was left to be the whole answer. It now carries one:
    // leaving is a deliberate, consequential act, and silence after it reads
    // as a click that did not register.
    const message = courseSettingsMessage({ state: "left" });
    expect(message?.tone).toBe("success");
    expect(message?.key).toBe("config:course.left");
  });
});

// ---------------------------------------------------------------------------
// The surface itself
// ---------------------------------------------------------------------------

describe("config action: the course intents write no configuration", () => {
  it.each(["join-course", "leave-course"] as const)("%s updates no config row", async (intent) => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: COURSE_ID,
      inviteId: 5,
      alreadyAttached: false,
    } as never);

    await post({ intent, course_code: "H7K2N9QRST", title: "Rewritten" });

    expect(currentDb.update).not.toHaveBeenCalled();
  });
});

describe("config loader: the join surface", () => {
  function loadArgs() {
    return {
      request: new Request("https://compositor.telar.org/config"),
      context: {
        get: vi.fn(() => ({ id: USER_ID, encrypted_access_token: "enc-token" })),
        cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "s", DB: {} } },
      },
      params: {},
    } as never;
  }

  it("offers the form on an unattached site", async () => {
    asRole("convenor");

    const data = (await loader(loadArgs())) as { course: { courseName: string | null } | null };

    expect(data.course).toEqual({ courseName: null });
  });

  it("names the course an attached site belongs to", async () => {
    asRole("convenor", { parent_project_id: COURSE_ID });

    const data = (await loader(loadArgs())) as { course: { courseName: string | null } | null };

    expect(data.course).toEqual({ courseName: "History 101" });
  });

  it("offers nothing on a course project, which cannot join a course", async () => {
    asRole("convenor", { kind: "course" });

    const data = (await loader(loadArgs())) as { course: unknown };

    expect(data.course).toBeNull();
  });
});
