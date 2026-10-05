/**
 * A story the full sync's check lists as unreadable because its own sheet has
 * columns read as one field, each holding values (`columns_collide`), is
 * offered in the column picker with every other sheet's groups,
 * whether or not the objects, project or glossary sheet refuses too. The
 * choice is committed, and the next check reads the story.
 *
 * The action, the picker's reads and the repair run for real; the check
 * itself (`computeFullSyncDiff`), GitHub and D1 are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const repo = vi.hoisted(() => ({ head: "head-sha", files: {} as Record<string, string> }));

vi.mock("~/lib/db.server", () => {
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "set", "values", "returning", "innerJoin", "leftJoin", "groupBy"]) {
      node[m] = () => chain();
    }
    return node;
  };
  const handle = { select: () => chain(), update: () => chain(), insert: () => chain(), delete: () => chain() };
  return { getDb: vi.fn(() => handle) };
});
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => repo.head),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
    repo.files[path] === undefined ? { status: "absent" } : { status: "ok", content: repo.files[path] },
  ),
  listDirectoryEntries: vi.fn(async (_t: string, _o: string, _r: string, _c: string, dir: string) =>
    Object.keys(repo.files)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => ({ path, mode: "100644", type: "blob", sha: "x" })),
  ),
  searchGitHubUsers: vi.fn(async () => []),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => []),
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1, github_repo_full_name: "owner/repo", head_sha: "base-sha", onboarding_completed: 1 },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/sync.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/sync.server")>("~/lib/sync.server");
  return { ...actual, computeFullSyncDiff: vi.fn() };
});
vi.mock("~/lib/commit.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/commit.server")>("~/lib/commit.server");
  return { ...actual, commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "repaired-sha" })) };
});
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => undefined) }));

import { action } from "~/routes/_app.dashboard";
import { commitFilesToRepo } from "~/lib/commit.server";
import { computeFullSyncDiff, type FullSyncDiff } from "~/lib/sync.server";
import { canonicalForCompareFromFiles } from "~/lib/story-content.server";
import { reasonOf } from "~/lib/story-unreadable.server";
import type { UnreadableReason } from "~/lib/story-canonical";

const STORY = "telar-content/spreadsheets/story-one.csv";
const COLLIDED_STORY = "step,object,x,y,zoom,question,pregunta,answer\n1,obj-001,0.5,0.5,1,What?,¿Qué?,An answer\n";
const OBJECTS = "telar-content/spreadsheets/objects.csv";

/** The check as the full sync answers it, with the story's content change as given. */
function checkWith(reason: UnreadableReason | { code: string } | null): FullSyncDiff {
  const changes = reason
    ? [{ story_id: "story-one", kind: "unreadable", acceptByDefault: false, reason, summary: { d1Steps: 1, headSteps: null, changedSteps: 0 }, expected: null }]
    : [];
  return {
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null },
    stories: { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, changes, suppressedEditorOnly: 0 } },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    headSha: repo.head,
  } as unknown as FullSyncDiff;
}

/** Why the story reader cannot read the story's sheet at the head, as the check lists it; null where it reads. */
async function storyReadAtHead(): Promise<UnreadableReason | null> {
  try {
    const story = await canonicalForCompareFromFiles("story-one", repo.files[STORY], {});
    return story.readable ? null : story.reason;
  } catch (err) {
    return reasonOf(err);
  }
}

function postToDashboardForStory(fields: Record<string, string>) {
  const request = new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ siteId: "1", ...fields }).toString(),
  });
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}")) })) },
  };
  const context = { get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })), cloudflare: { env } };
  // biome-ignore lint/suspicious/noExplicitAny: the action's generated argument type
  return action({ request, context, params: {} } as any) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.head = "head-sha";
  repo.files = { [OBJECTS]: "object_id,title\nobj-001,First\n", [STORY]: COLLIDED_STORY };
});

describe("a story sheet with columns read as one field, in the full sync", () => {
  it("is offered in the picker, though no other sheet refuses", async () => {
    vi.mocked(computeFullSyncDiff).mockResolvedValue(checkWith({ code: "columns_collide", column: "question", headers: ["question", "pregunta"] }));
    const answer = await postToDashboardForStory({ intent: "compute-full-sync-diff" });
    expect(answer.error).toBe("needs_choices");
    expect(answer.groups.map((g: { file: string; claim: string }) => [g.file, g.claim])).toEqual([[STORY, "question"]]);
  });

  it("commits the chosen column, and the next check lists the story as it reads", async () => {
    vi.mocked(computeFullSyncDiff).mockResolvedValue(checkWith({ code: "columns_collide", column: "question", headers: ["question", "pregunta"] }));
    const asked = await postToDashboardForStory({ intent: "compute-full-sync-diff" });
    const chosen = await postToDashboardForStory({
      intent: "choose-columns",
      sheet_challenge: asked.challenge,
      sheet_choices: JSON.stringify([{ file: STORY, positions: [5, 6], keep: 5 }]),
    });
    expect(chosen).toEqual({ ok: true, intent: "choose-columns" });
    const written = vi.mocked(commitFilesToRepo).mock.calls[0][4];

    // The next check reads the committed sheet with the story reader the full
    // sync uses, so a sheet the repair left colliding is listed again.
    repo.head = "repaired-sha";
    repo.files[STORY] = written[0].content;
    vi.mocked(computeFullSyncDiff).mockImplementation(async () => checkWith(await storyReadAtHead()));
    const synced = await postToDashboardForStory({ intent: "compute-full-sync-diff" });
    expect(synced.ok).toBe(true);
    // Not listed as unreadable for any reason: a repair that left the story
    // unreadable some other way fails here as surely as one left colliding.
    const listed = synced.diff.stories.content.changes.filter((c: { story_id: string }) => c.story_id === "story-one");
    expect(listed).toEqual([]);
    expect(written).toEqual([{ path: STORY, content: "step,object,x,y,zoom,question,answer\n1,obj-001,0.5,0.5,1,What?,An answer\n", verbatim: true }]);
  });

  it("leaves a story unreadable for any other reason in the check", async () => {
    vi.mocked(computeFullSyncDiff).mockResolvedValue(checkWith({ code: "files_unreadable" }));
    const answer = await postToDashboardForStory({ intent: "compute-full-sync-diff" });
    expect(answer.ok).toBe(true);
  });
});
