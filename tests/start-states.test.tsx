// @vitest-environment jsdom

/**
 * This file pins the four role × state renders of the Start page and its
 * Atelier components (role gating).
 *
 * The four variants:
 *   - convenor × empty:        first-run "Set up your project" checklist
 *   - convenor × populated:    welcome strip + workflow map (live counts)
 *   - collaborator × empty:    "Today, three things to get started" checklist
 *   - collaborator × populated: welcome strip, Publish tile LOCKED (no action)
 *
 * Gating is don't-render (never render-then-disable): the collaborator Publish
 * tile is locked (no Link, no `disabled` button); empty views render the
 * role-specific checklist instead of the descriptive summary.
 *
 * @version v1.3.0-beta
 */

import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { WelcomeStrip } from "~/components/features/start/WelcomeStrip";
import { WorkflowMap } from "~/components/features/start/WorkflowMap";
import StartPage from "~/routes/_app.start";

// Controllable role for useIsConvenor / useRole.
let mockIsConvenor = true;
vi.mock("~/hooks/use-role", () => ({
  useIsConvenor: () => mockIsConvenor,
  useRole: () => (mockIsConvenor ? "convenor" : "collaborator"),
}));

// Keep the real react-router exports (MemoryRouter, Link) but stub the shell
// loader read so the page's Publish "N to ship" count is controllable. Also
// stub useFetcher — the OrphanRecoveryCard mounts one, and MemoryRouter is not
// a data router (the card's submit wiring is covered by its own test).
let mockShellData: { unpublishedCount?: number } | null = { unpublishedCount: 3 };
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useRouteLoaderData: () => mockShellData,
    useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() }),
  };
});

// The route module imports server-only helpers at top level (for its loader).
// Stub them so importing the default-export PAGE component is side-effect free
// — the page itself never calls these.
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/session.server", () => ({ createSessionStorage: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));

// i18n: an interpolating identity-ish map covering the start namespace keys
// the components touch.
const I18N_MAP: Record<string, string> = {
  "workflow_tile.step": "Step",
  "welcome.eyebrow_default": "Project",
  "welcome.eyebrow_collab_empty": "You were invited",
  "welcome.title_collab_empty": "Welcome to {{project}}",
  "welcome.convened_by_one": "convened by {{convenor}} · {{count}} collaborator · created {{year}}",
  "welcome.convened_by_other": "convened by {{convenor}} · {{count}} collaborators · created {{year}}",
  "role_chip.convenor": "You · Convenor",
  "role_chip.collaborator": "You · Collaborator",
  "orientation.what_is_compositor": "What is the compositor?",
  "orientation.plan_narrative": "Plan your narrative",
  "orientation.add_collaborators": "Add collaborators",
  "section.workflow_map": "How the compositor works",
  "section.from_the_docs": "From the docs",
  "section.activity": "Activity · latest",
  "section.other_projects": "Your other projects · {{N}}",
  "activity.empty": "No edits yet.",
  "activity.see_all": "See all activity",
  "recovery.eyebrow": "Needs your attention",
  "recovery.body": "{{N}} story files exist in your GitHub repo.",
  "recovery.primary_cta": "Restore as drafts",
  "recovery.secondary_cta": "Ignore",
  "recovery.ignore_aria": "Ignore orphaned stories",
  "other_projects.pill_draft": "Draft",
  "other_projects.pill_in_sync": "In sync",
  "other_projects.pill_unpublished_some": "Unpublished",
  "other_projects.edited_relative": "edited {{relative}}",
  "workflow.hint": "click any step to jump in · each tile links to the right step",
  "checklist.convenor_heading": "Set up your project — three things first",
  "checklist.convenor_step1": "Confirm site title and theme in Site settings",
  "checklist.convenor_step2": "Add your first object",
  "checklist.convenor_step3": "Invite your team and write a first story",
  "checklist.collaborator_heading": "Today, three things to get started",
  "checklist.collaborator_step1": "Start with “What is the compositor?”",
  "checklist.collaborator_step2": "Browse the Objects tab",
  "checklist.collaborator_step3": "Open a story step and start writing",
  "tile.configure": "Configure",
  "tile.objects": "Objects",
  "tile.stories": "Stories",
  "tile.glossary": "Glossary",
  "tile.pages": "Pages",
  "tile.publish": "Publish",
  "pill.done": "Done",
  "pill.not_started": "Not started",
  "pill.empty": "Empty",
  "pill.none_yet": "None yet",
  "pill.landing_only": "Landing only",
  "pill.convenor_only": "Convenor-only",
  "pill.nothing_to_publish": "Nothing to publish yet",
  "pill.to_ship": "{{N}} to ship",
  "pill.objects_unused": "{{N}} · {{U}} unused",
  "pill.stories_drafts": "{{N}} · {{D}} drafts",
  "pill.terms": "{{N}} terms",
  "pill.pages": "{{N}} pages",
};

function interpolate(s: string, opts?: Record<string, unknown>): string {
  if (!opts) return s;
  let out = s;
  for (const [k, v] of Object.entries(opts)) out = out.replace(`{{${k}}}`, String(v));
  return out;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      interpolate(I18N_MAP[key] ?? key, opts),
    // FromTheDocs / DocsDrawer read i18n.language to pick the doc body language.
    i18n: { language: "en" },
  }),
  // FromTheDocs renders its hint via <Trans>.
  Trans: ({ i18nKey }: { i18nKey?: string }) =>
    i18nKey ? (I18N_MAP[i18nKey] ?? i18nKey) : null,
}));

const POPULATED_COUNTS = {
  configured: true,
  objects: 12,
  objectsUnused: 3,
  stories: 5,
  storyDrafts: 2,
  terms: 8,
  pages: 4,
};
const EMPTY_COUNTS = {
  configured: false,
  objects: 0,
  objectsUnused: 0,
  stories: 0,
  storyDrafts: 0,
  terms: 0,
  pages: 0,
};

function renderWelcome(role: "convenor" | "collaborator", state: "populated" | "empty") {
  return render(
    <MemoryRouter>
      <WelcomeStrip
        projectName="Telar de prueba"
        summary="A descriptive project summary."
        role={role}
        convenorName="Alice"
        collaboratorCount={2}
        createdYear={2024}
        state={state}
      />
    </MemoryRouter>,
  );
}

function renderMap(
  role: "convenor" | "collaborator",
  state: "populated" | "empty",
) {
  mockIsConvenor = role === "convenor";
  return render(
    <MemoryRouter>
      <WorkflowMap
        counts={state === "empty" ? EMPTY_COUNTS : POPULATED_COUNTS}
        unpublishedCount={3}
        empty={state === "empty"}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConvenor = true;
});

// ---------------------------------------------------------------------------
// WelcomeStrip — checklist swap + role chip
// ---------------------------------------------------------------------------

describe("WelcomeStrip — four role × state renders", () => {
  it("convenor × empty: renders the 'Set up your project — three things first' checklist", () => {
    renderWelcome("convenor", "empty");
    expect(screen.getByText("Set up your project — three things first")).toBeTruthy();
    expect(screen.getByText("You · Convenor")).toBeTruthy();
    // No descriptive summary when empty.
    expect(screen.queryByText("A descriptive project summary.")).toBeNull();
  });

  it("convenor × populated: renders the welcome summary + role chip, no checklist", () => {
    renderWelcome("convenor", "populated");
    expect(screen.getByText("A descriptive project summary.")).toBeTruthy();
    expect(screen.getByText("You · Convenor")).toBeTruthy();
    expect(screen.queryByText("Set up your project — three things first")).toBeNull();
  });

  it("collaborator × empty: renders the 'Today, three things to get started' checklist", () => {
    renderWelcome("collaborator", "empty");
    expect(screen.getByText("Today, three things to get started")).toBeTruthy();
    expect(screen.getByText("You · Collaborator")).toBeTruthy();
    // Invited eyebrow variant.
    expect(screen.getByText("You were invited")).toBeTruthy();
  });

  it("collaborator × populated: renders the welcome strip with the collaborator role chip", () => {
    renderWelcome("collaborator", "populated");
    expect(screen.getByText("You · Collaborator")).toBeTruthy();
    expect(screen.getByText("A descriptive project summary.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// WorkflowMap — Publish lock (don't-render the action)
// ---------------------------------------------------------------------------

describe("WorkflowMap — Publish tile lock (don't-render gating)", () => {
  it("convenor × populated: Publish tile is a live link with the '3 to ship' pill", () => {
    const { container } = renderMap("convenor", "populated");
    expect(screen.getByText("3 to ship")).toBeTruthy();
    // A link to /publish exists (live action).
    const publishLink = container.querySelector('a[href="/publish"]');
    expect(publishLink).not.toBeNull();
  });

  it("collaborator × populated: Publish tile is LOCKED — no /publish link, no disabled button", () => {
    const { container } = renderMap("collaborator", "populated");
    expect(screen.getByText("Convenor-only")).toBeTruthy();
    // Don't-render the action: no navigation target to /publish.
    expect(container.querySelector('a[href="/publish"]')).toBeNull();
    // And never a disabled button (don't-render, not render-then-disable).
    expect(container.querySelector("button[disabled]")).toBeNull();
    expect(container.querySelector("button[aria-disabled='true']")).toBeNull();
  });

  it("convenor × empty: tiles dim and the Publish pill reads 'Nothing to publish yet'", () => {
    renderMap("convenor", "empty");
    expect(screen.getByText("Nothing to publish yet")).toBeTruthy();
    // Objects + Glossary both show the "Empty" soft pill in the empty state.
    expect(screen.getAllByText("Empty").length).toBeGreaterThanOrEqual(2);
  });

  it("renders live counts in the populated state (objects '12 · 3 unused', stories '5 · 2 drafts')", () => {
    renderMap("convenor", "populated");
    expect(screen.getByText("12 · 3 unused")).toBeTruthy();
    expect(screen.getByText("5 · 2 drafts")).toBeTruthy();
    expect(screen.getByText("8 terms")).toBeTruthy();
    expect(screen.getByText("4 pages")).toBeTruthy();
  });

  it("renders all six step tiles in STEP order", () => {
    const { container } = renderMap("convenor", "populated");
    const steps = within(container).getAllByText(/^Step · \d$/);
    expect(steps.map((s) => s.textContent)).toEqual([
      "Step · 1",
      "Step · 2",
      "Step · 3",
      "Step · 4",
      "Step · 5",
      "Step · 6",
    ]);
  });
});

// ---------------------------------------------------------------------------
// StartPage — full page composition, four role × state renders
// ---------------------------------------------------------------------------

function makeLoaderData(
  role: "convenor" | "collaborator",
  state: "populated" | "empty",
  opts?: { orphanStoryIds?: string[]; otherProjects?: unknown[]; activity?: unknown[] },
) {
  return {
    project: { id: 1, github_repo_full_name: "alice/telar-site" },
    userRole: role,
    counts: state === "empty" ? EMPTY_COUNTS : POPULATED_COUNTS,
    convenorName: "Alice",
    collaboratorCount: 2,
    createdYear: 2024,
    summary: "A descriptive project summary.",
    state,
    activity: opts?.activity ?? [],
    orphanStoryIds: opts?.orphanStoryIds ?? [],
    otherProjects: opts?.otherProjects ?? [],
  };
}

function renderPage(
  role: "convenor" | "collaborator",
  state: "populated" | "empty",
  opts?: { orphanStoryIds?: string[]; otherProjects?: unknown[]; activity?: unknown[] },
) {
  mockIsConvenor = role === "convenor";
  mockShellData = { unpublishedCount: 3 };
  // Route.ComponentProps — the page reads `loaderData`; other fields unused.
  const Page = StartPage as unknown as (p: { loaderData: unknown }) => ReactElement;
  return render(
    <MemoryRouter>
      <Page loaderData={makeLoaderData(role, state, opts)} />
    </MemoryRouter>,
  );
}

const OTHER_PROJECT = {
  id: 2,
  github_repo_full_name: "alice/another-site",
  head_sha: "a",
  published_sha: "a",
  last_published_at: "2024-05-01T00:00:00Z",
  last_edited_at: "2024-06-01T00:00:00Z",
};

describe("StartPage — four role × state renders", () => {
  it("convenor × empty: renders the 'Set up your project' checklist + dimmed workflow map", () => {
    renderPage("convenor", "empty");
    expect(screen.getByText("Set up your project — three things first")).toBeTruthy();
    // Workflow map present (its section heading renders).
    expect(screen.getByText("How the compositor works")).toBeTruthy();
    // Empty Publish pill (convenor, nothing to ship).
    expect(screen.getByText("Nothing to publish yet")).toBeTruthy();
  });

  it("convenor × populated: renders the welcome strip, workflow map and live Publish link", () => {
    const { container } = renderPage("convenor", "populated");
    expect(screen.getByText("A descriptive project summary.")).toBeTruthy();
    expect(screen.getByText("How the compositor works")).toBeTruthy();
    // Publish "N to ship" sourced from the shell unpublishedCount (3).
    expect(screen.getByText("3 to ship")).toBeTruthy();
    expect(container.querySelector('a[href="/publish"]')).not.toBeNull();
  });

  it("collaborator × empty: renders the 'Today, three things to get started' checklist", () => {
    renderPage("collaborator", "empty");
    expect(screen.getByText("Today, three things to get started")).toBeTruthy();
    expect(screen.getByText("You · Collaborator")).toBeTruthy();
  });

  it("collaborator × populated: no convenor-only affordances — Publish locked, no disabled buttons", () => {
    const { container } = renderPage("collaborator", "populated");
    expect(screen.getByText("Convenor-only")).toBeTruthy();
    // Don't-render the action: no /publish link, no disabled affordance, no banner.
    expect(container.querySelector('a[href="/publish"]')).toBeNull();
    expect(container.querySelector("button[disabled]")).toBeNull();
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("composes the 1.65fr/1fr Atelier grid with gap-[18px] and a gap-[14px] rail slot", () => {
    const { container } = renderPage("convenor", "populated");
    // Atelier grid uses the 18px gap exception + the 1.65fr/1fr template,
    // collapsing to one column below 1000px.
    const grids = Array.from(container.querySelectorAll("div.grid")).filter(
      (el) =>
        el.className.includes("gap-[18px]") &&
        el.className.includes("min-[1000px]:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]"),
    );
    expect(grids).toHaveLength(1);
    // Right-rail slot placeholder with the 14px rail gap.
    const rail = container.querySelector('aside[data-rail-slot="true"]');
    expect(rail).not.toBeNull();
    expect(rail?.className).toContain("gap-[14px]");
  });
});

// ---------------------------------------------------------------------------
// StartPage — rail + ribbon gating
// ---------------------------------------------------------------------------

describe("StartPage — rail + ribbon gating", () => {
  it("always renders the activity feed; shows the empty message when there are no rows", () => {
    renderPage("convenor", "populated", { activity: [] });
    expect(screen.getByText("Activity · latest")).toBeTruthy();
    expect(screen.getByText("No edits yet.")).toBeTruthy();
  });

  it("convenor × populated × orphans-exist: renders the recovery card", () => {
    renderPage("convenor", "populated", { orphanStoryIds: ["s1", "s2"] });
    expect(screen.getByText("Needs your attention")).toBeTruthy();
  });

  it("convenor × populated × no orphans: recovery card absent", () => {
    renderPage("convenor", "populated", { orphanStoryIds: [] });
    expect(screen.queryByText("Needs your attention")).toBeNull();
  });

  it("collaborator × populated: recovery card absent even when orphans exist", () => {
    renderPage("collaborator", "populated", { orphanStoryIds: ["s1", "s2"] });
    expect(screen.queryByText("Needs your attention")).toBeNull();
  });

  it("empty state: recovery card absent even for a convenor with orphans", () => {
    renderPage("convenor", "empty", { orphanStoryIds: ["s1"] });
    expect(screen.queryByText("Needs your attention")).toBeNull();
  });

  it("populated state: other-projects ribbon renders when other projects exist", () => {
    renderPage("convenor", "populated", { otherProjects: [OTHER_PROJECT] });
    expect(screen.getByText("Your other projects · 1")).toBeTruthy();
  });

  it("empty state: other-projects ribbon absent even when other projects exist", () => {
    renderPage("convenor", "empty", { otherProjects: [OTHER_PROJECT] });
    expect(screen.queryByText("Your other projects · 1")).toBeNull();
  });

  it("populated state with no other projects: ribbon absent", () => {
    renderPage("convenor", "populated", { otherProjects: [] });
    expect(screen.queryByText(/Your other projects/)).toBeNull();
  });
});
