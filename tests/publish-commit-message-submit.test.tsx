// @vitest-environment jsdom
/**
 * The page has to tell the action which state its commit message describes.
 *
 * The action can compare the site's state against a fingerprint, but only the
 * page knows whether the message it is submitting is the summary it generated
 * or something the author typed — and only the page can render the neutral
 * fallback headline, because the message is localised through `t` and the
 * action has no locale. So both travel with the publish: the fingerprint the
 * loader stamped on the summary, and the neutral headline to fall back to.
 *
 * The fingerprint rides along only when the message is the generated one. A
 * message the author edited is not an inventory of a read and cannot go stale
 * in the sense that matters; substituting a neutral headline for their words
 * would be its own kind of wrong.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

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
/** Declaration order in the route: validation, publish, poll, repair, repairPoll. */
const publishFetcher = () => fetchers.publish;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => {
    const f = fetchers[FETCHER_SLOTS[fetcherCallIndex % FETCHER_SLOTS.length]];
    fetcherCallIndex += 1;
    return f;
  },
  redirect: (url: string) => ({ url }),
  useOutletContext: () => ({}),
  useRouteLoaderData: () => ({ repoUnavailable: false, repoFullName: "owner/repo" }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
}));

vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useIsPublisher: () => true, useRole: () => "convenor" }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    provider: null,
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
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  requireOwner: vi.fn(),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn() }));
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
  buildConfigManagedFields: vi.fn(),
  buildConfigChangeFields: vi.fn(),
  buildPageContentHashes: vi.fn(),
  ENTITY_HASHES_VERSION: 4,
}));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(),
  normalizeVersionTag: vi.fn(),
}));

vi.mock("~/components/features/publish/ChangeSummary", () => ({
  ChangeSummary: () => <div data-testid="change-summary" />,
}));
vi.mock("~/components/features/publish/ValidationChecks", () => ({
  ValidationChecks: () => <div data-testid="validation-checks" />,
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const emptyBucket = { new: [], modified: [], deleted: [] };
function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    stories: { new: [{ story_id: "s1", title: "One" }], modified: [], deleted: [] },
    objects: emptyBucket,
    pages: emptyBucket,
    glossary: emptyBucket,
    settings: { changed: [] },
    landing: { changed: false },
    navigation: { changed: false },
    objectOrder: { changed: false },
    backCompatBootstrap: false,
    isUpToDate: false,
    ...overrides,
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
    changeSummary: makeSummary(),
    user: { github_login: "u", github_name: "U", github_email: "u@e.co" },
    snapshotOk: true,
    summaryFingerprint: "fingerprint-abc",
    ...overrides,
  };
}

async function renderPublish(loaderData: Record<string, unknown>) {
  const mod = (await import("~/routes/_app.publish")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  return render(<mod.default loaderData={loaderData as never} />);
}

function clickPublish() {
  const button = screen
    .getByText("publish_section.publish_now")
    .closest("button") as HTMLButtonElement;
  fireEvent.click(button);
}

function submitted(): Record<string, unknown> {
  const calls = publishFetcher().submit.mock.calls;
  expect(calls.length).toBe(1);
  return calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  resetFetchers();
  vi.clearAllMocks();
  // Publish waits for the checks to answer; these tests start from an answer.
  fetchers.validation.data = { ok: true, intent: "run-validation", validation: { blockers: [], warnings: [] } };
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe("Publish page — what travels with a generated commit message", () => {
  it("submits the fingerprint of the state the message was built from", async () => {
    await renderPublish(makeLoaderData());
    clickPublish();

    expect(submitted().summaryFingerprint).toBe("fingerprint-abc");
  });

  it("submits the neutral headline for the action to fall back to", async () => {
    // The action has no locale, so the fallback has to be rendered here.
    await renderPublish(makeLoaderData());
    clickPublish();

    expect(submitted().fallbackHeadline).toBe("auto_commit.default_headline");
  });

  it("names a changed order of objects in the generated message", async () => {
    await renderPublish(makeLoaderData({
      changeSummary: makeSummary({ stories: emptyBucket, objectOrder: { changed: true } }),
    }));
    clickPublish();

    expect((submitted().commitMessage as string).toLowerCase()).toContain("auto_commit.reorder_objects");
  });

  it("does not name a reorder of objects on a first publish", async () => {
    // The summary a first publish of a site with objects computes, by the real rule.
    const { computeChangeSummary, ENTITY_HASHES_VERSION } =
      await vi.importActual<typeof import("~/lib/publish.server")>("~/lib/publish.server");
    const firstPublish = computeChangeSummary({
      entityHashes: {
        version: ENTITY_HASHES_VERSION, pages: {}, stories: {}, objects: { a: "h-a", b: "h-b" }, glossary: {},
        navigation: "", landing: "", settings: "", objectOrder: '["a","b"]',
      },
      config: null,
      stories: [],
      objects: [{ object_id: "a", title: "A" }, { object_id: "b", title: "B" }],
      pages: [],
      glossary: [],
      allStoryIds: [],
    }, null);
    await renderPublish(makeLoaderData({ changeSummary: firstPublish }));
    clickPublish();

    expect((submitted().commitMessage as string).toLowerCase()).not.toContain("auto_commit.reorder_objects");
  });

  it("still submits the message itself and the intent", async () => {
    await renderPublish(makeLoaderData());
    clickPublish();

    const fields = submitted();
    expect(fields.intent).toBe("publish");
    expect(typeof fields.commitMessage).toBe("string");
    expect((fields.commitMessage as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The honest paths
// ---------------------------------------------------------------------------

describe("Publish page — a message the author wrote", () => {
  it("does not submit a fingerprint for an edited message", async () => {
    await renderPublish(makeLoaderData());

    fireEvent.click(
      screen.getByText("publish_section.edit_message").closest("button") as HTMLButtonElement,
    );
    const textarea = screen.getByLabelText("commit.label") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "Fix the dates on the Bogotá photographs" },
    });
    fireEvent.click(screen.getByText("commit.publish_button").closest("button") as HTMLButtonElement);

    const fields = submitted();
    expect(fields.commitMessage).toBe("Fix the dates on the Bogotá photographs");
    expect(fields.summaryFingerprint).toBeUndefined();
  });

  it("still submits the fingerprint when the author opened the editor and changed nothing", async () => {
    // An untouched editor submits the generated message verbatim, so it is
    // still an inventory of the loader's read.
    await renderPublish(makeLoaderData());

    fireEvent.click(
      screen.getByText("publish_section.edit_message").closest("button") as HTMLButtonElement,
    );
    fireEvent.click(screen.getByText("commit.publish_button").closest("button") as HTMLButtonElement);

    expect(submitted().summaryFingerprint).toBe("fingerprint-abc");
  });

  it("submits nothing extra when the loader could not read the state", async () => {
    // The message is already the neutral headline in that case; a fingerprint
    // of a read that failed would claim more than the page knows.
    await renderPublish(makeLoaderData({ snapshotOk: false, summaryFingerprint: null }));
    clickPublish();

    expect(submitted().summaryFingerprint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Leaving the editor
// ---------------------------------------------------------------------------

describe("Publish page — the commit-message editor can be closed", () => {
  const openEditor = () =>
    fireEvent.click(
      screen.getByText("publish_section.edit_message").closest("button") as HTMLButtonElement,
    );

  it("keeps the blocker note on screen while the editor is open", async () => {
    fetchers.validation.data = {
      ok: true,
      intent: "run-validation",
      validation: { blockers: [{ code: "stale_head", message: "stale_head" }], warnings: [] },
    };
    await renderPublish(makeLoaderData());
    expect(screen.queryByText("publish_section.blocked_note")).not.toBeNull();

    openEditor();

    expect(screen.queryByText("publish_section.blocked_note")).not.toBeNull();
  });

  it("closes on Done editing and keeps what the author typed", async () => {
    await renderPublish(makeLoaderData());
    openEditor();
    fireEvent.change(screen.getByLabelText("commit.label"), {
      target: { value: "Fix the dates on the Bogotá photographs" },
    });

    fireEvent.click(screen.getByText("publish_section.done_editing").closest("button") as HTMLButtonElement);

    expect(screen.queryByLabelText("commit.label")).toBeNull();
    expect(screen.queryByText("Fix the dates on the Bogotá photographs")).not.toBeNull();
    clickPublish();
    expect(submitted().commitMessage).toBe("Fix the dates on the Bogotá photographs");
    expect(submitted().summaryFingerprint).toBeUndefined();
  });

  it("returns to the generated message when the author closes an untouched editor", async () => {
    await renderPublish(makeLoaderData());
    openEditor();
    fireEvent.click(screen.getByText("publish_section.done_editing").closest("button") as HTMLButtonElement);
    clickPublish();

    expect(submitted().summaryFingerprint).toBe("fingerprint-abc");
  });
});

// ---------------------------------------------------------------------------
// A publish that only corrects headings
// ---------------------------------------------------------------------------

describe("Publish page — the headline of a publish that corrects headings", () => {
  const heading = {
    code: "sheet_warning",
    message: "sheet_warning",
    entityId: "objects.csv/0",
    sheetWarning: { code: "header_spelling", headers: ["Object_ID"], names: ["object_id"], sheet: "objects.csv" },
  };
  const nothingChanged = () => makeSummary({ stories: emptyBucket, isUpToDate: true });

  beforeEach(() => {
    fetchers.validation.data = { ok: true, intent: "run-validation", validation: { blockers: [], warnings: [heading] } };
  });

  it("names the correction when the summary is otherwise empty, and says so to the action", async () => {
    await renderPublish(makeLoaderData({ changeSummary: nothingChanged() }));
    clickPublish();

    expect(submitted().commitMessage).toBe("auto_commit.correct_headings");
    expect(submitted().correctsHeadings).toBe("1");
  });

  it("leaves the headline of a publish with changes as it was", async () => {
    await renderPublish(makeLoaderData());
    clickPublish();

    expect(submitted().commitMessage).not.toBe("auto_commit.correct_headings");
    expect(submitted().correctsHeadings).toBeUndefined();
  });

  it("keeps the neutral headline when no file has headings to correct", async () => {
    fetchers.validation.data = { ok: true, intent: "run-validation", validation: { blockers: [], warnings: [] } };
    await renderPublish(makeLoaderData({ changeSummary: makeSummary({ stories: emptyBucket }) }));
    clickPublish();

    expect(submitted().commitMessage).toBe("auto_commit.default_headline");
    expect(submitted().correctsHeadings).toBeUndefined();
  });
});
