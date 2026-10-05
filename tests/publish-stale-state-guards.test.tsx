// @vitest-environment jsdom
/**
 * When the loader's forced snapshot did not run, everything the Publish page
 * derives from D1 is a claim about a state the document has already moved past.
 * Withholding the diff is not enough on its own: the same read also feeds the
 * pre-publish checks and the commit message, and both of those travel further
 * than the screen.
 *
 * The checks decide whether the publish button is offered at all, so a clean
 * verdict from an unread state is the page vouching for content it never saw.
 * The commit message is worse — it is submitted with the publish and becomes
 * the permanent record on GitHub of what that commit contained, so a stale
 * summary writes a false inventory into the repository's history, where nothing
 * later can correct it.
 *
 * Neither is replaced with a better guess. The checks say they could not run
 * and the message falls back to its neutral default, because the page has
 * nothing true to say about a state it could not read. What actually guards the
 * publish is the action's own re-check, which runs after its own snapshot
 * against the rows being committed.
 *
 * Publishing itself stays available throughout: a load-time failure that has
 * cleared by the time the author presses publish must not cost them the
 * publish.
 *
 * The page's wiring of the build-workflow repair is asserted here too, on the
 * props it hands `ValidationChecks`: the repair is another thing the page says
 * about a state that can move under it. The rebuild that repair's commit starts
 * is followed here as well, by a poll of the page's own that touches neither the
 * publish flow's build tracking nor the awareness the pill reads.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { deriveWorkflowRepairBuild } from "~/lib/workflow-repair-build";
import {
  getLastPublishFailure,
  __resetPublishFailureForTests as resetPublishFailure,
} from "~/lib/publish-failure-capture";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface FetcherStub {
  data: unknown;
  state: "idle" | "submitting" | "loading";
  submit: ReturnType<typeof vi.fn>;
}
/**
 * One stub per `useFetcher()` call the page makes, named for the slot it fills
 * in declaration order: validation, publish, poll-build, workflow repair,
 * the repair's own build poll.
 */
const FETCHER_SLOTS = ["validation", "publish", "poll", "repair", "repairPoll"] as const;
type FetcherSlot = (typeof FETCHER_SLOTS)[number];
let fetchers: Record<FetcherSlot, FetcherStub> = {} as Record<FetcherSlot, FetcherStub>;
let fetcherCallIndex = 0;
/** Props of the last `ValidationChecks` render. */
let lastChecksProps: Record<string, unknown> = {};
const makeFetcher = (): FetcherStub => ({ data: undefined, state: "idle", submit: vi.fn() });
function resetFetchers() {
  fetchers = {
    validation: makeFetcher(),
    publish: makeFetcher(),
    poll: makeFetcher(),
    repair: makeFetcher(),
    repairPoll: makeFetcher(),
  };
  fetcherCallIndex = 0;
}
const validationFetcher = () => fetchers.validation;
const publishFetcher = () => fetchers.publish;

/** Every `submit` payload any fetcher received this render. */
function submittedIntents(): string[] {
  return Object.values(fetchers).flatMap((f) =>
    f.submit.mock.calls.map((c) => (c[0] as { intent?: string })?.intent ?? ""),
  );
}

// One `t`, as real i18next hands back. The publish-response effect depends on
// `[publishData, t]` and sets state from a fresh object, so a `t` that changed
// identity per render would spin that effect for as long as a commit result
// stands.
const stableT = (key: string) => key;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: stableT }),
}));

vi.mock("react-router", () => ({
  // A fresh object per call, not the stub itself: the page wraps every
  // fetcher through `useSiteFetcher` (`~/lib/page-site`), whose own memo keys
  // on the fetcher object's identity, so a stub mutated in place and handed
  // back by reference would be invisible to it.
  useFetcher: () => {
    const f = fetchers[FETCHER_SLOTS[fetcherCallIndex % FETCHER_SLOTS.length]];
    fetcherCallIndex += 1;
    return { data: f.data, state: f.state, submit: f.submit };
  },
  redirect: (url: string) => ({ url }),
  useOutletContext: () => ({}),
  useRouteLoaderData: () => ({ repoUnavailable: false, repoFullName: "owner/repo" }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
}));

vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useIsPublisher: () => true, useRole: () => "convenor" }));
/**
 * The awareness provider is mutable so one suite can hand the page a real
 * recorder: an assertion that the repair broadcasts nothing is vacuous against
 * a null provider, which has nothing to broadcast through.
 */
let collaborationProvider: { awareness: { setLocalStateField: ReturnType<typeof vi.fn> } } | null =
  null;
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    provider: collaborationProvider,
    isPublishing: false,
    publishError: false,
    remoteCollaborators: [],
    ydoc: null,
  }),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({ getRepoHead: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn(), requireOwner: vi.fn() }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn() }));
vi.mock("~/lib/upgrade.server", () => ({ healMissingFrameworkFiles: vi.fn() }));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/publish.server", () => ({
  computeChangeSummary: vi.fn(),
  buildEntityHashes: vi.fn(),
  findEntityMaxUpdatedAt: vi.fn(),
  computeStoryDeletions: vi.fn(),
  computePageDeletions: vi.fn(),
  runPrePublishValidation: vi.fn(),
  buildPublishFileSet: vi.fn(),
  buildConfigChangeFields: vi.fn(),
  buildPageContentHashes: vi.fn(),
  ENTITY_HASHES_VERSION: 4,
}));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));

vi.mock("~/components/features/publish/ChangeSummary", () => ({
  ChangeSummary: () => <div data-testid="change-summary" />,
}));
vi.mock("~/components/features/publish/CommitMessageEditor", () => ({
  CommitMessageEditor: () => <div data-testid="commit-editor" />,
}));
// The checks render inert, but their props are recorded: the repair button and
// its status line live inside the real component, so what the page hands it is
// what the page's wiring can be asserted on.
vi.mock("~/components/features/publish/ValidationChecks", () => ({
  ValidationChecks: (props: Record<string, unknown>) => {
    lastChecksProps = props;
    return <div data-testid="validation-checks" />;
  },
  ValidationWarnings: () => null,
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const emptyBucket = { new: [], modified: [], deleted: [] };

/** A summary describing real work — the inventory a stale read must not claim. */
function summaryWithChanges() {
  return {
    stories: emptyBucket,
    objects: emptyBucket,
    pages: { new: [{ slug: "about", title: "About" }], modified: [], deleted: [] },
    glossary: emptyBucket,
    settings: { changed: [] },
    landing: { changed: false },
    navigation: { changed: false },
    objectOrder: { changed: false },
    backCompatBootstrap: false,
    isUpToDate: false,
  };
}

function makeLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      id: 1,
      head_sha: "old-sha",
      published_sha: null,
      last_published_at: null,
      publish_snapshot: null,
      github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo",
      installation_id: 123,
    },
    changeSummary: summaryWithChanges(),
    user: { github_login: "u", github_name: "U", github_email: "u@e.co" },
    snapshotOk: true,
    ...overrides,
  };
}

async function renderPublish(loaderData: Record<string, unknown>) {
  const mod = (await import("~/routes/_app.publish")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  return render(<mod.default loaderData={loaderData as never} />);
}

/**
 * The commit message card — the text `handlePublish` submits verbatim.
 * Lower-cased because the generator title-cases the headline's first letter,
 * which is styling, not content.
 */
function commitMessageText(): string {
  const pre = document.querySelector("pre");
  return (pre?.textContent ?? "").toLowerCase();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFetchers();
  collaborationProvider = null;
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe("Publish page — a stale read must not reach the commit or the checks", () => {
  it("does not describe the withheld summary in the commit message", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: false }));

    const message = commitMessageText();
    expect(message).not.toContain("auto_commit.add_pages");
    expect(message).not.toContain("auto_commit.entry_page");
    expect(message).toContain("auto_commit.default_headline");
  });

  it("does not run the pre-publish checks against the unread state", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: false }));

    expect(submittedIntents()).not.toContain("run-validation");
    expect(validationFetcher().submit).not.toHaveBeenCalled();
  });

  it("says the checks could not run instead of leaving a spinner", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: false }));

    // The checks section says so in its own words rather than repeating the
    // diff's notice verbatim, and it must not be left mid-flight forever —
    // `ValidationChecks` spins for a null result, which is what a page that
    // never runs the checks would otherwise show.
    expect(screen.getByText("checks.state_unavailable")).toBeTruthy();
    expect(screen.queryByTestId("validation-checks")).toBeNull();
  });

  it("still lets the author publish", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: false }));

    const button = screen
      .getByText("publish_section.publish_now")
      .closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("names the action's refusal rather than falling back to a generic failure", async () => {
    publishFetcher().data = {
      ok: false,
      intent: "publish",
      error: "validation_blocked",
    };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(screen.getByText("build.validation_blocked")).toBeTruthy();
    expect(screen.queryByText("build.failed_description")).toBeNull();
  });
});

const PUBLISH_FAILED = {
  ok: false,
  intent: "publish",
  error: "publish_failed",
  projectId: 1,
  message:
    'Failed query: update "config_managed" set "story_key" = ? params: s3cr3t-story-key',
};

describe("Publish page — a publish that failed before reaching GitHub", () => {
  beforeEach(() => {
    resetPublishFailure();
  });

  it("says the site has not changed, not that a build went wrong", async () => {
    publishFetcher().data = { ...PUBLISH_FAILED };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(screen.getByText("build.publish_failed_description")).toBeTruthy();
    expect(screen.queryByText("build.failed_description")).toBeNull();
  });

  it("records the code against the project, and never the server's message", async () => {
    publishFetcher().data = { ...PUBLISH_FAILED };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    const failure = getLastPublishFailure(1);
    expect(failure).toMatchObject({ error: "publish_failed", projectId: 1 });
    expect(JSON.stringify(failure)).not.toContain("s3cr3t-story-key");
    expect(screen.queryByText(/s3cr3t-story-key/)).toBeNull();
  });

  it("records a refusal too", async () => {
    publishFetcher().data = { ok: false, intent: "publish", error: "stale_head", projectId: 1 };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(getLastPublishFailure(1)).toMatchObject({ error: "stale_head", projectId: 1 });
  });

  it("records the failure against the project the action acted on, not the one the page shows", async () => {
    // Another tab switched the session to project 2; this page still shows 1.
    publishFetcher().data = { ...PUBLISH_FAILED, projectId: 2 };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(getLastPublishFailure(2)).toMatchObject({ error: "publish_failed", projectId: 2 });
    expect(getLastPublishFailure(1)).toBeNull();
  });

  it("records nothing when the response names no project", async () => {
    publishFetcher().data = { ok: false, intent: "publish", error: "stale_head" };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(getLastPublishFailure(1)).toBeNull();
  });

  it("still falls back to the build copy for a code it does not know", async () => {
    publishFetcher().data = { ok: false, intent: "publish", error: "something_new" };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(screen.getByText("build.failed_description")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The honest path — the ordinary publish is untouched.
// ---------------------------------------------------------------------------

describe("Publish page — a readable state behaves exactly as before", () => {
  it("runs the checks on mount", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(validationFetcher().submit).toHaveBeenCalledWith(
      { intent: "run-validation" },
      { method: "post" },
    );
  });

  it("still writes the change inventory into the commit message", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: true }));

    const message = commitMessageText();
    expect(message).toContain("auto_commit.add_pages");
    expect(message).toContain("auto_commit.entry_page");
  });

  it("shows the diff and no unavailable notice", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(screen.getByTestId("change-summary")).toBeTruthy();
    expect(screen.queryByText("review.state_unavailable")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The build-workflow repair the stale-workflow warning offers.
// ---------------------------------------------------------------------------

describe("Publish page — the build-workflow repair", () => {
  interface WorkflowRepairProp {
    status: string;
    reauthUrl: string | null;
    onRepair: () => void;
  }

  const workflowRepair = () => lastChecksProps.workflowRepair as WorkflowRepairProp;

  const runValidationCount = () =>
    submittedIntents().filter((i) => i === "run-validation").length;

  it("submits the repair intent and nothing else", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: true }));

    workflowRepair().onRepair();

    expect(fetchers.repair.submit).toHaveBeenCalledTimes(1);
    const [payload, options] = fetchers.repair.submit.mock.calls[0];
    expect(payload).toEqual({ intent: "repair-build-workflow" });
    expect(options).toEqual({ method: "post" });
  });

  it("re-runs the checks once a repair settles, and not again on a re-render", async () => {
    fetchers.repair.data = {
      ok: true,
      intent: "repair-build-workflow",
      outcome: "repaired",
      newHeadSha: "repair-sha",
      recorded: true,
    };

    const { rerender } = await renderPublish(makeLoaderData({ snapshotOk: true }));

    // One run on mount, one because the repair changed the repository.
    expect(runValidationCount()).toBe(2);

    const mod = (await import("~/routes/_app.publish")) as unknown as {
      default: React.ComponentType<{ loaderData: unknown }>;
    };
    rerender(<mod.default loaderData={makeLoaderData({ snapshotOk: true }) as never} />);

    expect(runValidationCount()).toBe(2);
  });

  it("re-runs the checks again for a second, distinct successful repair", async () => {
    const mod = (await import("~/routes/_app.publish")) as unknown as {
      default: React.ComponentType<{ loaderData: unknown }>;
    };
    const rerenderPublish = () =>
      lastRender.rerender(<mod.default loaderData={makeLoaderData({ snapshotOk: true }) as never} />);

    const lastRender = await renderPublish(makeLoaderData({ snapshotOk: true }));
    expect(runValidationCount()).toBe(1); // the mount-time run only — no repair yet

    fetchers.repair.data = {
      ok: true,
      intent: "repair-build-workflow",
      outcome: "repaired",
      newHeadSha: "repair-sha-1",
      recorded: true,
    };
    rerenderPublish();
    expect(runValidationCount()).toBe(2);

    // Re-rendering with that same result object again must not add a run.
    rerenderPublish();
    expect(runValidationCount()).toBe(2);

    // A second, distinct successful repair result re-runs the checks once more.
    fetchers.repair.data = {
      ok: true,
      intent: "repair-build-workflow",
      outcome: "repaired",
      newHeadSha: "repair-sha-2",
      recorded: true,
    };
    rerenderPublish();
    expect(runValidationCount()).toBe(3);

    // And a re-render of that second result adds nothing either.
    rerenderPublish();
    expect(runValidationCount()).toBe(3);
  });

  it("keeps saying the repair is done after the re-run clears the warning", async () => {
    fetchers.repair.data = {
      ok: true,
      intent: "repair-build-workflow",
      outcome: "repaired",
      newHeadSha: "repair-sha",
      recorded: true,
    };
    // The re-run came back with nothing left to warn about.
    validationFetcher().data = {
      ok: true,
      intent: "run-validation",
      validation: { blockers: [], warnings: [] },
    };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(workflowRepair().status).toBe("done");
  });

  it("reads as running while the repair is in flight", async () => {
    fetchers.repair.state = "submitting";

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(workflowRepair().status).toBe("running");
  });

  it("carries the settings URL through when GitHub refused the commit", async () => {
    fetchers.repair.data = {
      ok: false,
      intent: "repair-build-workflow",
      error: "insufficient_permissions",
      reauthUrl: "https://github.com/organizations/owner/settings/installations/42",
    };

    await renderPublish(makeLoaderData({ snapshotOk: true }));

    expect(workflowRepair().status).toBe("permission");
    expect(workflowRepair().reauthUrl).toBe(
      "https://github.com/organizations/owner/settings/installations/42",
    );
  });

  it("names a moved head and a plain failure apart", async () => {
    fetchers.repair.data = {
      ok: false,
      intent: "repair-build-workflow",
      error: "stale_head",
    };
    await renderPublish(makeLoaderData({ snapshotOk: true }));
    expect(workflowRepair().status).toBe("stale");

    resetFetchers();
    fetchers.repair.data = {
      ok: false,
      intent: "repair-build-workflow",
      error: "workflow_repair_failed",
    };
    await renderPublish(makeLoaderData({ snapshotOk: true }));
    expect(workflowRepair().status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// The rebuild the repair's commit starts. The repair's commit carries no
// `[skip ci]`, so GitHub builds the site; the page follows that build with a
// poll of its own, and nothing the publish flow owns is touched by it.
// ---------------------------------------------------------------------------

interface RepairBuild {
  state: "building" | "rebuilt" | "failed" | "cancelled";
  buildUrl: string | null;
}
interface RepairPollState {
  buildStatus: string;
  buildConclusion: string | null;
  buildUrl: string | null;
}

async function loadRoute() {
  return (await import("~/routes/_app.publish")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
}

describe("the repair's build, derived from its poll", () => {
  const derive = async (poll: RepairPollState | null, publishFollowed = false) =>
    deriveWorkflowRepairBuild(poll, publishFollowed);

  const run = (buildStatus: string, buildConclusion: string | null, buildUrl = null as string | null) => ({
    buildStatus,
    buildConclusion,
    buildUrl,
  });

  it("says nothing before the session's first response", async () => {
    expect(await derive(null)).toBeNull();
  });

  it("is building for every status short of completed", async () => {
    // `pending` with no run is GitHub not having registered the run yet — a
    // successful answer, not an absent one.
    expect(await derive(run("pending", null))).toEqual({ state: "building", buildUrl: null });
    expect(await derive(run("queued", null))).toEqual({ state: "building", buildUrl: null });
    expect(await derive(run("in_progress", null, "https://gh/run/1"))).toEqual({
      state: "building",
      buildUrl: "https://gh/run/1",
    });
  });

  it("reads the conclusion only once the run has completed", async () => {
    expect(await derive(run("completed", "success", "https://gh/run/1"))).toEqual({
      state: "rebuilt",
      buildUrl: "https://gh/run/1",
    });
    expect(await derive(run("completed", "failure", "https://gh/run/1"))).toEqual({
      state: "failed",
      buildUrl: "https://gh/run/1",
    });
    expect(await derive(run("completed", "cancelled", "https://gh/run/1"))).toEqual({
      state: "cancelled",
      buildUrl: "https://gh/run/1",
    });
  });

  it("treats every conclusion that is neither success nor cancellation as a failure", async () => {
    for (const conclusion of ["timed_out", "action_required", "neutral", "skipped", "stale", null]) {
      expect(await derive(run("completed", conclusion)), conclusion ?? "null").toEqual({
        state: "failed",
        buildUrl: null,
      });
    }
  });

  it("says nothing about a cancellation this page's own publish explains", async () => {
    expect(await derive(run("completed", "cancelled", "https://gh/run/1"), true)).toBeNull();
    // Only cancellation collapses: a failed rebuild is still a failed rebuild.
    expect(await derive(run("completed", "failure", "https://gh/run/1"), true)).toEqual({
      state: "failed",
      buildUrl: "https://gh/run/1",
    });
  });
});

describe("Publish page — following the repair's build", () => {
  interface WorkflowRepairProp {
    status: string;
    reauthUrl: string | null;
    build: RepairBuild | null;
    onRepair: () => void;
  }
  const workflowRepair = () => lastChecksProps.workflowRepair as WorkflowRepairProp;

  const repaired = (newHeadSha: string) => ({
    ok: true,
    intent: "repair-build-workflow",
    outcome: "repaired",
    newHeadSha,
    recorded: true,
  });
  /** An answer names the commit it answers for, as the action's does. */
  const pollResponse = (
    buildStatus: string,
    buildConclusion: string | null,
    buildUrl: string | null = null,
    sha = "repair-sha",
  ) => ({
    ok: true,
    intent: "poll-build",
    sha,
    buildStatus,
    buildConclusion,
    buildUrl,
    runId: buildStatus === "pending" ? null : 42,
    phases: null,
  });

  const pollFailed = (sha = "repair-sha") => ({
    ok: false,
    intent: "poll-build",
    sha,
    error: "poll_failed",
  });

  const publishResponse = () => ({
    ok: true,
    intent: "publish",
    newHeadSha: "publish-sha",
    commitUrl: "https://gh/commit/1",
  });

  const pollSubmits = () => fetchers.repairPoll.submit.mock.calls;

  let view!: ReturnType<typeof render>;

  /** Re-render with the fetcher state the test has just set. */
  async function rerender() {
    const mod = await loadRoute();
    await act(async () => {
      view.rerender(<mod.default loaderData={makeLoaderData({ snapshotOk: true }) as never} />);
    });
  }

  async function mount() {
    const mod = await loadRoute();
    // Publish waits for the checks to answer; these tests start from an answer.
    fetchers.validation.data = { ok: true, intent: "run-validation", validation: { blockers: [], warnings: [] } };
    await act(async () => {
      view = render(<mod.default loaderData={makeLoaderData({ snapshotOk: true }) as never} />);
    });
  }

  /** Land a poll response and let the page act on it. */
  async function respond(data: unknown) {
    fetchers.repairPoll.data = data;
    await rerender();
  }

  async function tick(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  async function click(label: string) {
    const button = screen.getByText(label).closest("button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
  }

  /** Submit a publish from the page, as the author does. */
  const startPublish = () => click("publish_section.publish_now");

  /** Open a repair session, then settle its `repaired` result. */
  async function startRepair(sha: string) {
    await act(async () => {
      workflowRepair().onRepair();
    });
    fetchers.repair.data = repaired(sha);
    await rerender();
  }

  /**
   * Bring the checks back on screen after a publish committed: the checks
   * section is replaced by the publish flow while `publishResult` stands, and
   * the retry that clears it is offered on the build-failure card.
   */
  async function retryAfterFailedPublishBuild() {
    fetchers.poll.data = {
      ok: true,
      intent: "poll-build",
      sha: "publish-sha",
      buildStatus: "completed",
      buildConclusion: "failure",
      buildUrl: "https://gh/run/publish",
      runId: 7,
      phases: null,
    };
    await rerender();
    await click("failure_card.try_again");
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the repair's sha, and sends nothing else", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();

    expect(pollSubmits()).toHaveLength(1);
    const [payload, options] = pollSubmits()[0];
    expect(payload).toEqual({ intent: "poll-build", sha: "repair-sha" });
    expect(options).toEqual({ method: "post" });
  });

  it("does not poll for an outcome that committed nothing", async () => {
    for (const outcome of ["already_current", "not_needed"]) {
      resetFetchers();
      fetchers.repair.data = { ok: true, intent: "repair-build-workflow", outcome };
      await mount();
      expect(fetchers.repairPoll.submit, outcome).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it("schedules exactly one more submit five seconds after a response that is not done", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();

    await respond(pollResponse("in_progress", null, "https://gh/run/1"));

    await tick(4999);
    expect(pollSubmits()).toHaveLength(1);

    await tick(1);
    expect(pollSubmits()).toHaveLength(2);
    // The run id is never sent: it selects nothing, and the line shows no steps.
    expect(pollSubmits()[1][0]).toEqual({ intent: "poll-build", sha: "repair-sha" });

    // One response, one further submit — the timer does not repeat on its own.
    await tick(20000);
    expect(pollSubmits()).toHaveLength(2);
  });

  it("submits nothing when the timer fires while the poll is still in flight", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();
    await respond(pollResponse("in_progress", null, "https://gh/run/1"));

    fetchers.repairPoll.state = "submitting";
    await rerender();

    await tick(5000);
    expect(pollSubmits()).toHaveLength(1);
  });

  it("stops once the run reports completed", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();

    await respond(pollResponse("completed", "success", "https://gh/run/1"));
    await tick(20000);

    expect(pollSubmits()).toHaveLength(1);
    expect(workflowRepair().build).toEqual({ state: "rebuilt", buildUrl: "https://gh/run/1" });
  });

  it("keeps saying the site is rebuilding while GitHub has not registered the run", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();

    await respond(pollResponse("pending", null));
    expect(workflowRepair().build).toEqual({ state: "building", buildUrl: null });

    await tick(5000);
    await respond(pollResponse("pending", null));
    expect(workflowRepair().build).toEqual({ state: "building", buildUrl: null });

    await tick(5000);
    await respond(pollResponse("in_progress", null, "https://gh/run/7"));
    expect(workflowRepair().build).toEqual({ state: "building", buildUrl: "https://gh/run/7" });
    expect(pollSubmits()).toHaveLength(3);
  });

  it("gives each repair its own session, which the previous one cannot end", async () => {
    fetchers.repair.data = repaired("repair-sha-1");
    await mount();
    await respond(pollResponse("in_progress", null, "https://gh/run/1", "repair-sha-1"));
    expect(workflowRepair().build).toEqual({ state: "building", buildUrl: "https://gh/run/1" });

    // A second repair. The pending timer is dropped and the first session's
    // build is forgotten before the new repair is even submitted.
    await act(async () => {
      workflowRepair().onRepair();
    });
    await rerender();
    expect(workflowRepair().build).toBeNull();

    await tick(20000);
    expect(pollSubmits()).toHaveLength(1);

    // The first session's last response lands late: it must not render, and it
    // must not make the new session look finished.
    await respond(pollResponse("completed", "success", "https://gh/run/1", "repair-sha-1"));
    expect(workflowRepair().build).toBeNull();

    // The new repair settles and polls under its own sha.
    fetchers.repair.data = repaired("repair-sha-2");
    await rerender();
    expect(pollSubmits()).toHaveLength(2);
    expect(pollSubmits()[1][0]).toEqual({ intent: "poll-build", sha: "repair-sha-2" });
  });

  it("drops an answer that names another commit, and schedules nothing off it", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();

    await respond(pollResponse("completed", "success", "https://gh/run/1", "some-other-sha"));

    expect(workflowRepair().build).toBeNull();
    await tick(20000);
    expect(pollSubmits()).toHaveLength(1);
  });

  it("keeps the second repair's rebuild when the first repair's answer lands in the same render", async () => {
    fetchers.repair.data = repaired("repair-sha-1");
    await mount();
    await respond(pollResponse("in_progress", null, "https://gh/run/1", "repair-sha-1"));

    await act(async () => {
      workflowRepair().onRepair();
    });

    // The second repair settles and the first repair's last poll returns in one
    // render. The session counter cannot separate them on its own: the new
    // session is open by the time the response is read. The sha can — the
    // response answers for the commit before it.
    fetchers.repair.data = repaired("repair-sha-2");
    fetchers.repairPoll.data = pollResponse(
      "completed",
      "success",
      "https://gh/run/1",
      "repair-sha-1",
    );
    await rerender();

    expect(workflowRepair().build).toBeNull();
    expect(pollSubmits()).toHaveLength(2);
    expect(pollSubmits()[1][0]).toEqual({ intent: "poll-build", sha: "repair-sha-2" });

    await tick(20000);
    expect(pollSubmits()).toHaveLength(2);

    // The second repair's own answers are what the line and the next submit
    // follow.
    await respond(pollResponse("in_progress", null, "https://gh/run/9", "repair-sha-2"));
    expect(workflowRepair().build).toEqual({ state: "building", buildUrl: "https://gh/run/9" });
    await tick(5000);
    expect(pollSubmits()).toHaveLength(3);
    expect(pollSubmits()[2][0]).toEqual({ intent: "poll-build", sha: "repair-sha-2" });
  });

  it("asks again after a poll that failed, and leaves the line where it stood", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();
    await respond(pollResponse("in_progress", null, "https://gh/run/1"));
    await tick(5000);
    expect(pollSubmits()).toHaveLength(2);

    await respond(pollFailed());
    // A failure says nothing about the build, so the rebuilding line stands.
    expect(workflowRepair().build).toEqual({ state: "building", buildUrl: "https://gh/run/1" });

    await tick(4999);
    expect(pollSubmits()).toHaveLength(2);
    await tick(1);
    expect(pollSubmits()).toHaveLength(3);
    expect(pollSubmits()[2][0]).toEqual({ intent: "poll-build", sha: "repair-sha" });
  });

  it("drops the pending submit when the page goes away", async () => {
    fetchers.repair.data = repaired("repair-sha");
    await mount();
    await respond(pollResponse("in_progress", null, "https://gh/run/1"));

    view.unmount();
    await tick(20000);

    expect(pollSubmits()).toHaveLength(1);
  });

  it("tells the other clients nothing about the repair's build", async () => {
    collaborationProvider = { awareness: { setLocalStateField: vi.fn() } };
    fetchers.repair.data = repaired("repair-sha");
    await mount();

    // Everything the page broadcasts about its own publish state, captured
    // before the repair's build is followed at all.
    const baseline = collaborationProvider.awareness.setLocalStateField.mock.calls.length;
    expect(baseline).toBeGreaterThan(0);

    await respond(pollResponse("in_progress", null, "https://gh/run/1"));
    await tick(5000);
    await respond(pollResponse("completed", "success", "https://gh/run/1"));
    await tick(20000);

    expect(collaborationProvider.awareness.setLocalStateField.mock.calls).toHaveLength(baseline);
    for (const call of collaborationProvider.awareness.setLocalStateField.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("repair-sha");
    }
  });

  // The one cancellation the page can account for is a publish of its own that
  // started after the repair and reached a commit. Which publish that is turns
  // on when it was submitted, not on when its result came back.
  it("still names a cancellation when the publish it followed was already in flight", async () => {
    await mount();
    await startPublish();
    await startRepair("repair-sha");
    await respond(pollResponse("in_progress", null, "https://gh/run/1"));

    // The publish that preceded the repair commits, and its own build fails;
    // the retry brings the checks back with the repair line on them.
    fetchers.publish.data = publishResponse();
    await rerender();
    await retryAfterFailedPublishBuild();

    await respond(pollResponse("completed", "cancelled", "https://gh/run/1"));
    expect(workflowRepair().build).toEqual({
      state: "cancelled",
      buildUrl: "https://gh/run/1",
    });
  });

  it("says nothing about a cancellation once a publish that followed the repair has committed", async () => {
    await mount();
    await startRepair("repair-sha");
    await respond(pollResponse("in_progress", null, "https://gh/run/1"));

    await startPublish();
    fetchers.publish.data = publishResponse();
    await rerender();
    // The retry clears `publishResult`; what it cannot clear is that a publish
    // ran, and its build is the one the cancellation belongs to.
    await retryAfterFailedPublishBuild();

    await respond(pollResponse("completed", "cancelled", "https://gh/run/1"));
    expect(workflowRepair().build).toBeNull();
  });

  it("still names a cancellation when the publish that followed the repair never committed", async () => {
    await mount();
    await startRepair("repair-sha");
    await respond(pollResponse("in_progress", null, "https://gh/run/1"));

    await startPublish();
    // A publish that was refused started no build, so it explains nothing.
    fetchers.publish.data = { ok: false, intent: "publish", error: "stale_head" };
    await rerender();

    await respond(pollResponse("completed", "cancelled", "https://gh/run/1"));
    expect(workflowRepair().build).toEqual({
      state: "cancelled",
      buildUrl: "https://gh/run/1",
    });
  });
});
