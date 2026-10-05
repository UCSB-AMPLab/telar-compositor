// @vitest-environment jsdom
/**
 * The Start page shows what the orphan restore or ignore came to.
 *
 * The card's fetcher is keyed, and the page reads that key's answer rather
 * than the card, because a restore that recovers every orphan removes the
 * card: the loader mounts it only while orphans remain. So each case renders
 * the page with no orphans left, and the outcome has to be on screen anyway.
 * Sentences are resolved against the shipped catalogues.
 *
 * @version v1.5.0-beta
 */

import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("~/hooks/use-role", () => ({
  useIsConvenor: () => true,
  useIsPublisher: () => true,
  useRole: () => "convenor",
}));

/** The data each keyed fetcher holds; an unkeyed fetcher holds nothing. */
const fetcherData = new Map<string, unknown>();
/** The state each keyed fetcher is in; idle unless a case says otherwise. */
const fetcherState = new Map<string, "idle" | "submitting" | "loading">();
// The shell's status poll reads through `fetch` in a data router; this page
// test has neither, and the poll has not answered.
vi.mock("~/hooks/use-github-status-poll", () => ({ useGithubStatusPoll: () => undefined }));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useRouteLoaderData: () => ({ unpublishedCount: 0 }),
    useFetcher: (opts?: { key?: string }) => ({
      state: (opts?.key && fetcherState.get(opts.key)) || "idle",
      data: opts?.key ? fetcherData.get(opts.key) : undefined,
      submit: vi.fn(),
      load: vi.fn(),
    }),
  };
});

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/session.server", () => ({ createSessionStorage: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));

vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  const byNamespace = new Map<string, ReturnType<typeof catalogueT>>();
  const tFor = (ns: string) => {
    if (!byNamespace.has(ns)) byNamespace.set(ns, catalogueT(ns, "en"));
    return byNamespace.get(ns)!;
  };
  return {
    useTranslation: (ns?: string | string[]) => ({
      t: tFor(Array.isArray(ns) ? ns[0] : (ns ?? "common")),
      i18n: { language: "en" },
    }),
    Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
  };
});

import StartPage from "~/routes/_app.start";
import { ORPHAN_RECOVERY_FETCHER_KEY } from "~/components/features/start/OrphanRecoveryCard";

function renderPage(orphanStoryCount = 0) {
  const Page = StartPage as unknown as (p: { loaderData: unknown }) => ReactElement;
  const page = () => (
    <MemoryRouter>
      <Page
        loaderData={{
          project: { id: 1, github_repo_full_name: "alice/telar-site" },
          userRole: "convenor",
          counts: { configured: true, objects: 1, objectsUnused: 0, stories: 1, storyDrafts: 0, terms: 0, pages: 0 },
          convenorName: "Alice",
          collaboratorCount: 0,
          createdYear: 2024,
          summary: "A summary.",
          state: "populated",
          activity: [],
          orphanStoryCount,
          otherProjects: [],
        }}
      />
    </MemoryRouter>
  );
  const view = render(page());
  return { ...view, rerenderPage: () => view.rerender(page()) };
}

function answer(data: unknown) {
  fetcherData.set(ORPHAN_RECOVERY_FETCHER_KEY, data);
}

beforeEach(() => {
  fetcherData.clear();
  fetcherState.clear();
});

describe("the Start page's orphan restore outcome", () => {
  it("shows the restore's warnings after the card has gone", () => {
    answer({
      ok: true,
      intent: "restore-orphan-drafts",
      restored: 2,
      warnings: [{ code: "ragged_row", row: { label: "1" }, sheet: "story-two.csv" }],
    });
    renderPage();
    expect(screen.queryByText("Restore as drafts")).toBeNull();
    expect(screen.getByText(/Your stories were restored as drafts/)).toBeTruthy();
    expect(screen.getByText(/Row "1" in the sheet "story-two.csv" has values in columns with no heading/)).toBeTruthy();
  });

  it("shows nothing for a restore with no warnings", () => {
    answer({ ok: true, intent: "restore-orphan-drafts", restored: 2, warnings: [] });
    renderPage();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says there was nothing left to restore", () => {
    answer({ ok: true, intent: "restore-orphan-drafts", restored: 0, warnings: [] });
    renderPage();
    expect(screen.getByText(/There was nothing left to restore/)).toBeTruthy();
  });

  it("names the sheet and the columns of a refused restore", () => {
    answer({
      ok: false,
      intent: "restore-orphan-drafts",
      error: "colliding_columns",
      collidingColumns: { sheet: "story-one.csv", canonicalName: "question", headers: ["question", "pregunta"] },
    });
    renderPage(1);
    expect(
      screen.getByText(/The sheet "story-one.csv" has columns Telar reads as one \("question", "pregunta"\)/),
    ).toBeTruthy();
  });

  it("names a file the restore could not read, and says nothing was restored", () => {
    answer({ ok: false, intent: "restore-orphan-drafts", error: "sheet_unreadable", sheet: "story-one.csv", warnings: [] });
    renderPage(1);
    expect(
      screen.getByText(
        'We couldn\'t read the sheet "story-one.csv" from GitHub, so nothing was restored. Try again in a moment.',
      ),
    ).toBeTruthy();
  });

  it("names a file other than a sheet that the restore could not read", () => {
    answer({
      ok: false,
      intent: "restore-orphan-drafts",
      error: "file_unreadable",
      file: "telar-content/texts/stories/x/panel.md",
      warnings: [],
    });
    renderPage(1);
    expect(
      screen.getByText(
        'We couldn\'t read the file "telar-content/texts/stories/x/panel.md" from GitHub, so nothing was restored. Try again in a moment.',
      ),
    ).toBeTruthy();
  });

  it.each(["restore-orphan-drafts", "ignore-orphans"])("%s: says the ignore list could not be read", (intent) => {
    answer({ ok: false, intent, error: "ignore_list_unreadable" });
    renderPage(1);
    expect(
      screen.getByText(
        "We couldn't read the list of stories you chose to ignore from GitHub, so nothing changed. Try again in a moment.",
      ),
    ).toBeTruthy();
  });

  it.each([
    ["restore-orphan-drafts", "restore_failed"],
    ["ignore-orphans", "ignore_failed"],
  ])("%s %s: says it did not go through, and never the raw message", (intent, error) => {
    answer({ ok: false, intent, error, message: "DO returned 500" });
    renderPage(1);
    expect(screen.getByText("That didn't go through. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText(/DO returned 500/)).toBeNull();
  });

  it("says the site could not be found", () => {
    answer({ ok: false, intent: "restore-orphan-drafts", error: "no_project" });
    renderPage(1);
    expect(screen.getByText(/Telar couldn't find this site/)).toBeTruthy();
  });

  it("shows nothing after an ignore", () => {
    answer({ ok: true, intent: "ignore-orphans", ignored: 2 });
    renderPage();
    expect(screen.queryByRole("status")).toBeNull();
  });

  // The keyed fetcher keeps its last answer while a new submission is in
  // flight, so the page shows an outcome only once the fetcher is idle again.
  it("hides a failed restore's outcome while Restore is submitted again", () => {
    answer({ ok: false, intent: "restore-orphan-drafts", error: "restore_failed", message: "DO returned 500" });
    const { rerenderPage } = renderPage(1);
    expect(screen.getByText("That didn't go through. Try again in a moment.")).toBeTruthy();
    fetcherState.set(ORPHAN_RECOVERY_FETCHER_KEY, "submitting");
    rerenderPage();
    expect(screen.queryByRole("status")).toBeNull();
    fetcherState.set(ORPHAN_RECOVERY_FETCHER_KEY, "loading");
    rerenderPage();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a refusal's sentence and the warnings raised before it", () => {
    answer({
      ok: false,
      intent: "restore-orphan-drafts",
      error: "colliding_columns",
      collidingColumns: { sheet: "story-two.csv", canonicalName: "question", headers: ["question", "pregunta"] },
      warnings: [{ code: "coordinate_invalid", step: 1, column: "x", value: "abc", sheet: "story-one.csv" }],
    });
    renderPage(1);
    expect(screen.getByText(/The sheet "story-two.csv" has columns Telar reads as one/)).toBeTruthy();
    expect(screen.getByText(/In the sheet "story-one.csv", step 1 has the value "abc" in x/)).toBeTruthy();
  });
});
