// @vitest-environment jsdom
/**
 * The retry on the Upgrade page's failed-build screen.
 *
 * By the time that screen renders, the upgrade commit has landed and the site's
 * recorded version is already the new one. There is no upgrade left to attempt:
 * a control that sent the owner back to the review screen would land on an
 * Upgrade button gated on `needsUpgrade`, which is false there, so it would
 * leave no trace. What failed is the build, so the retry runs the build again,
 * and the page follows the run GitHub says it started — at that run's own head,
 * whatever the branch has moved to in the meantime.
 *
 * Where GitHub accepts the dispatch but names no run, the page says so and stays
 * where it is. It does not pick a run out of a listing: a push or a competing
 * dispatch produces runs that are not this one, and following the wrong run
 * would report someone else's build as the owner's.
 *
 * The poll is asserted here too. It follows the run it was handed rather than
 * the newest for the sha, and it skips a tick while a request is still in
 * flight, because a fetcher that submits again aborts its own pending request.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface FetcherStub {
  data: unknown;
  state: "idle" | "submitting" | "loading";
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
}

/** One stub per `useFetcher()` the page calls, named for its slot in
 *  declaration order: the page's own reload, the upgrade itself, the build
 *  poll, the rebuild. */
const FETCHER_SLOTS = ["reload", "upgrade", "poll", "rebuild"] as const;
type FetcherSlot = (typeof FETCHER_SLOTS)[number];

let fetchers: Record<FetcherSlot, FetcherStub>;
let fetcherCallIndex = 0;

const makeFetcher = (): FetcherStub => ({ data: undefined, state: "idle", submit: vi.fn(), load: vi.fn() });

function resetFetchers() {
  fetchers = { reload: makeFetcher(), upgrade: makeFetcher(), poll: makeFetcher(), rebuild: makeFetcher() };
  fetcherCallIndex = 0;
}

/** Every payload the build poll was asked to submit, in order. */
function pollSubmissions(): Array<Record<string, string>> {
  return fetchers.poll.submit.mock.calls.map((c) => c[0] as Record<string, string>);
}

/**
 * Echoes the key followed by whatever the page interpolated into it. A stub
 * that returned the key alone would make "the version is still on screen"
 * indistinguishable from "some line rendered", which is the whole point of the
 * assertion that the landed upgrade's version survives a rebuild.
 *
 * One function identity, defined once: a `t` that changed identity per render
 * would spin any effect that depends on it.
 */
const stableT = (key: string, opts?: Record<string, unknown>) => {
  const values = opts ? Object.values(opts).map(String).join(" ") : "";
  return values ? `${key} ${values}` : key;
};
const ui = vi.hoisted(() => ({ language: "en" }));
vi.mock("react-i18next", () => ({
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) =>
    `${i18nKey} ${JSON.stringify(values ?? {})}`,
  useTranslation: () => ({ t: stableT, i18n: { get language() { return ui.language; } } }),
}));

vi.mock("react-router", () => ({
  // A fresh object per call (rather than the same stub reference) so that
  // `useSiteFetcher`'s memoisation (keyed on the fetcher it wraps) recomputes
  // on the render after a test mutates a stub's `.data` in place; `submit`
  // stays the same spy so assertions on it still see every call.
  useFetcher: () => {
    const slot = fetchers[FETCHER_SLOTS[fetcherCallIndex % FETCHER_SLOTS.length]];
    fetcherCallIndex += 1;
    return { ...slot };
  },
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  // The layout's member list, which names the holder of a lock; none here.
  useRouteLoaderData: () => undefined,
  // usePageSiteId's provider is mounted in the layout, not on this page, so
  // the location it reads is never exercised here.
  useLocation: () => ({ key: "test", pathname: "/upgrade" }),
  redirect: (url: string) => ({ url }),
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useIsPublisher: () => true, useRole: () => "convenor" }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ provider: null }),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ requirePublishingRole: vi.fn(), resolveActiveProject: vi.fn() }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeLoaderData() {
  return {
    siteVersion: "1.6.1",
    latestRelease: null,
    releaseNotes: "",
    releaseCount: 0,
    diff: null,
    filesByCategory: {},
    configContent: "",
    isBelowMinimum: false,
    needsUpgrade: true,
    googleSheetsEnabled: false,
    project: {
      id: 1,
      github_pages_url: "https://student.github.io/my-site",
      github_repo_full_name: "student/my-site",
    },
  };
}

let Page: React.ComponentType<{ loaderData: unknown }>;
let rerenderPage: () => void;

async function renderUpgrade() {
  const mod = (await import("~/routes/_app.upgrade")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  Page = mod.default;
  const loaderData = makeLoaderData();
  const view = render(<Page loaderData={loaderData as never} />);
  rerenderPage = () => {
    fetcherCallIndex = 0;
    view.rerender(<Page loaderData={loaderData as never} />);
  };
  return view;
}

/** Applies a change to the fetcher stubs and lets the page react to it. */
function push(change: () => void) {
  act(() => {
    change();
    rerenderPage();
  });
}

const COMMITTED = {
  ok: true,
  intent: "upgrade-commit",
  newHeadSha: "upgrade-sha",
  newVersion: "v1.6.2",
  owner: "student",
  repo: "my-site",
  manualSteps: { en: [{ description: "Regenerate IIIF tiles", kind: "action" }], es: [{ description: "Regenerar las teselas IIIF", kind: "action" }] },
};

const FAILED_RUN = {
  ok: true,
  intent: "poll-build",
  buildStatus: "completed",
  buildConclusion: "failure",
  buildUrl: "https://github.com/student/my-site/actions/runs/111",
  runId: 111,
  phases: [{ id: "setup", label: "Setup", status: "completed", conclusion: "failure" }],
};

/** Commit lands, the build is followed, the build fails. */
async function driveToFailedBuild() {
  const view = await renderUpgrade();
  push(() => {
    fetchers.upgrade.data = COMMITTED;
  });
  push(() => {
    fetchers.poll.data = FAILED_RUN;
  });
  expect(screen.getByText("upgradeFailed")).toBeTruthy();
  return view;
}

function clickRetry() {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFetchers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Upgrade page — the retry runs the build again", () => {
  it("submits rebuild rather than re-attempting the landed upgrade", async () => {
    await driveToFailedBuild();

    clickRetry();

    expect(fetchers.rebuild.submit).toHaveBeenCalledWith(
      { intent: "rebuild" },
      { method: "post" },
    );
    const upgradeIntents = fetchers.upgrade.submit.mock.calls.map(
      (c) => (c[0] as { intent?: string }).intent,
    );
    expect(upgradeIntents).not.toContain("upgrade-prepare");
  });

  it("follows the run GitHub named, at that run's own head", async () => {
    await driveToFailedBuild();
    clickRetry();

    push(() => {
      fetchers.rebuild.data = {
        ok: true,
        intent: "rebuild",
        runId: 900,
        headSha: "advanced-sha",
        buildUrl: "https://github.com/student/my-site/actions/runs/900",
      };
    });

    expect(screen.getByText("buildTracking")).toBeTruthy();
    const last = pollSubmissions().at(-1);
    expect(last).toEqual({ intent: "poll-build", sha: "advanced-sha", runId: "900" });
  });

  it("never polls the failed run's sha once the branch has advanced", async () => {
    await driveToFailedBuild();
    const before = pollSubmissions().length;
    clickRetry();

    push(() => {
      fetchers.rebuild.data = {
        ok: true,
        intent: "rebuild",
        runId: 900,
        headSha: "advanced-sha",
        buildUrl: "https://github.com/student/my-site/actions/runs/900",
      };
    });

    const after = pollSubmissions().slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const submission of after) {
      expect(submission.sha).toBe("advanced-sha");
    }
  });

  it("drops the failed run's build URL and phases when it enters the new build", async () => {
    await driveToFailedBuild();
    clickRetry();

    push(() => {
      fetchers.rebuild.data = {
        ok: true,
        intent: "rebuild",
        runId: 900,
        headSha: "advanced-sha",
        buildUrl: "https://github.com/student/my-site/actions/runs/900",
      };
    });

    // No phases yet for the new run, so the tracker is still waiting.
    expect(screen.getByText("waiting_build")).toBeTruthy();
    const link = screen.getByRole("link", { name: /view_on_github/ });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/student/my-site/actions/runs/900",
    );
  });

  it("keeps the landed upgrade's version and manual steps across the rebuild", async () => {
    await driveToFailedBuild();
    clickRetry();

    push(() => {
      fetchers.rebuild.data = {
        ok: true,
        intent: "rebuild",
        runId: 900,
        headSha: "advanced-sha",
        buildUrl: "https://github.com/student/my-site/actions/runs/900",
      };
    });
    push(() => {
      fetchers.poll.data = {
        ok: true,
        intent: "poll-build",
        buildStatus: "completed",
        buildConclusion: "success",
        buildUrl: "https://github.com/student/my-site/actions/runs/900",
        runId: 900,
        phases: null,
      };
    });

    // The upgrade landed before the first build ever ran, so the success screen
    // still has a version to name and the manifest's manual steps to list. The
    // version asserted is the one the commit response carried: nothing in the
    // rebuild response or the loader supplies it, so it can only have survived.
    expect(screen.getByText("upgradeSuccess")).toBeTruthy();
    expect(COMMITTED.newVersion).toBe("v1.6.2");
    expect(screen.getByText("upgradeSuccessDetail v1.6.2")).toBeTruthy();
    expect(screen.getByText("manualStepsIntro")).toBeTruthy();
    expect(screen.getByText("Regenerate IIIF tiles")).toBeTruthy();
    expect(screen.queryByText("manualStepsEmpty")).toBeNull();
  });

  async function driveToDone() {
    await driveToFailedBuild();
    clickRetry();
    push(() => {
      fetchers.rebuild.data = {
        ok: true,
        intent: "rebuild",
        runId: 900,
        headSha: "advanced-sha",
        buildUrl: "https://github.com/student/my-site/actions/runs/900",
      };
    });
    push(() => {
      fetchers.poll.data = {
        ok: true,
        intent: "poll-build",
        buildStatus: "completed",
        buildConclusion: "success",
        buildUrl: "https://github.com/student/my-site/actions/runs/900",
        runId: 900,
        phases: null,
      };
    });
  }

  it("lists the manual steps in the interface language, and follows a switch", async () => {
    ui.language = "es";
    try {
      await driveToDone();
      expect(screen.getByText("Regenerar las teselas IIIF")).toBeTruthy();
      expect(screen.queryByText("Regenerate IIIF tiles")).toBeNull();

      ui.language = "en";
      act(() => {
        rerenderPage();
      });
      expect(screen.getByText("Regenerate IIIF tiles")).toBeTruthy();
      expect(screen.queryByText("Regenerar las teselas IIIF")).toBeNull();
    } finally {
      ui.language = "en";
    }
  });

  it("stays on the failed screen and says so when GitHub names no run", async () => {
    await driveToFailedBuild();
    clickRetry();

    push(() => {
      fetchers.rebuild.data = {
        ok: true,
        intent: "rebuild",
        runId: null,
        headSha: null,
        buildUrl: "https://github.com/student/my-site/actions/workflows/build.yml",
      };
    });

    expect(screen.getByText("upgradeFailed")).toBeTruthy();
    expect(screen.getByText("rebuild_unconfirmed")).toBeTruthy();
    // The link is the one the response supplied, not the failed run's.
    const link = screen.getByRole("link", { name: /viewActions/ });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/student/my-site/actions/workflows/build.yml",
    );
  });

  it("stays on the failed screen with the failure line when the dispatch failed", async () => {
    await driveToFailedBuild();
    clickRetry();

    push(() => {
      fetchers.rebuild.data = { ok: false, intent: "rebuild", error: "rebuild_failed" };
    });

    expect(screen.getByText("upgradeFailed")).toBeTruthy();
    expect(screen.getByText("rebuild_failed")).toBeTruthy();
    expect(screen.queryByText("buildTracking")).toBeNull();
  });
});

describe("Upgrade page — the poll does not cancel itself", () => {
  it("keeps one poll in flight and still completes when the slow answer arrives", async () => {
    vi.useFakeTimers();
    await renderUpgrade();

    push(() => {
      fetchers.upgrade.data = COMMITTED;
    });
    expect(pollSubmissions()).toHaveLength(1);

    // The first poll is still in flight while two ticks pass.
    push(() => {
      fetchers.poll.state = "submitting";
    });
    act(() => {
      vi.advanceTimersByTime(11000);
    });
    expect(pollSubmissions()).toHaveLength(1);

    // The held answer finally lands.
    push(() => {
      fetchers.poll.state = "idle";
      fetchers.poll.data = {
        ok: true,
        intent: "poll-build",
        buildStatus: "completed",
        buildConclusion: "success",
        buildUrl: "https://github.com/student/my-site/actions/runs/111",
        runId: 111,
        phases: null,
      };
    });

    expect(screen.getByText("upgradeSuccess")).toBeTruthy();
    expect(pollSubmissions()).toHaveLength(1);
  });
});

// The commit refuses a target a newer release has overtaken, or a
// release it cannot read; the page says which, and reloads its data for the first.
describe("a commit refused over the latest release", () => {
  beforeEach(() => {
    fetchers.reload.load.mockClear();
  });

  it("says a newer release came out and reloads the page's data", async () => {
    await renderUpgrade();
    push(() => {
      fetchers.upgrade.data = { ok: false, intent: "upgrade-commit", error: "prepared_outdated" };
    });
    expect(screen.getByText("preparedOutdated")).toBeTruthy();
    expect(fetchers.reload.load).toHaveBeenCalledTimes(1);
    expect(fetchers.reload.load).toHaveBeenCalledWith("/upgrade");
  });

  it("says the release could not be read, and reloads nothing", async () => {
    await renderUpgrade();
    push(() => {
      fetchers.upgrade.data = { ok: false, intent: "upgrade-commit", error: "release_unknown" };
    });
    expect(screen.getByText("releaseUnknown")).toBeTruthy();
    expect(fetchers.reload.load).not.toHaveBeenCalled();
  });
});

// A list the manifest could not add to is named, with its file, key
// and values, in place of the generic failure.
describe("a prepare refused over a list the manifest could not add to", () => {
  it("names the file, the key and the values, and not the generic failure", async () => {
    await renderUpgrade();
    push(() => {
      fetchers.upgrade.data = {
        ok: false,
        intent: "upgrade-prepare",
        error: "config_exclude_unreadable",
        detail: { file: "_config.yml", key: "exclude", values: ["telar-content/texts/", "tests/"] },
      };
    });
    expect(screen.getByText("configExcludeUnreadable _config.yml exclude telar-content/texts/, tests/")).toBeTruthy();
    expect(screen.queryByText("upgradeFailedDetail")).toBeNull();
  });

  it("keeps the generic failure for any other manifest failure", async () => {
    await renderUpgrade();
    push(() => {
      fetchers.upgrade.data = { ok: false, intent: "upgrade-prepare", error: "manifest_failed" };
    });
    expect(screen.getByText("upgradeFailedDetail")).toBeTruthy();
    expect(screen.queryByText(/configExcludeUnreadable/)).toBeNull();
  });
});

// A read prepare could not complete is named, with the path and
// release version it names, in place of the generic failure.
describe("a prepare refused over a read it could not complete", () => {
  const cases: Array<[string, { path?: string; version?: string } | undefined, string]> = [
    ["upgrade_file_unreadable", { path: "telar-content/spreadsheets/project.csv" }, "upgradeFileUnreadable telar-content/spreadsheets/project.csv"],
    ["upgrade_file_not_text", { path: "_config.yml" }, "upgradeFileNotText _config.yml"],
    ["release_file_unreadable", { path: "migration.json", version: "1.8.0" }, "releaseFileUnreadable migration.json 1.8.0"],
    ["release_tree_unreadable", { version: "1.8.0" }, "releaseTreeUnreadable 1.8.0"],
    ["release_manifest_invalid", { version: "1.7.0" }, "releaseManifestInvalid 1.7.0"],
    ["release_list_unreadable", undefined, "releaseListUnreadable"],
  ];
  for (const [error, detail, text] of cases) {
    it(`names ${error} and not the generic failure`, async () => {
      await renderUpgrade();
      push(() => {
        fetchers.upgrade.data = { ok: false, intent: "upgrade-prepare", error, ...(detail ? { detail } : {}) };
      });
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByText("upgradeFailedDetail")).toBeNull();
    });
  }
});
