// @vitest-environment jsdom
/**
 * The rewritten Publish page's "What we checked" section renders a chilca-pale
 * numbered list of the checks that PASSED (the canonical passed-check label set
 * minus any failing codes — runPrePublishValidation only emits FAILURES, so
 * passed labels are derived from a static set minus the failures), alongside
 * the reworded `page_no_title` blocker that no longer interpolates an empty slug.
 *
 * The passed-check ↔ failing-code mapping lives in ValidationChecks: only
 * `object_metadata` is suppressed by a validation code (`object_no_title`);
 * the other four canonical checks have no code yet and always pass.
 *
 * i18n is mocked as a key-passthrough so assertions key off the translation
 * keys, not the copy. MemoryRouter wraps the render because the stale_head
 * blocker renders a <Link>.
 *
 * Several keys carry a fixture string instead of passing through, because a
 * message that renders a link needs a body with an interpolated value and a
 * <0> segment for the page's own splitter to work on. The splitting is the
 * page's, not a library's — see tests/validation-checks-authored-title.test.tsx,
 * which renders the same warning through the real i18next and the real
 * catalogues to pin what an author's own words become.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const { language, FIXTURE_STRINGS } = vi.hoisted(() => ({
  language: { current: "en" },
  FIXTURE_STRINGS: {
    "checks.private_story_workflow_stale":
      "These stories are private, but the workflow is stale: {{stories}}. <0>The upgrade notes explain how.</0>",
    "checks.private_story_no_key":
      "These stories are private, but no story key is set: {{stories}}.",
    "checks.workflow_repair_permission":
      "GitHub refused. <0>Review the app's permissions</0> and try again.",
    "checks.workflow_repair_build_failed":
      "The workflow is up to date, but the rebuild failed. <0>See the build details</0>.",
    "checks.workflow_repair_build_cancelled":
      "The workflow is up to date, but the rebuild was cancelled. <0>See the build details</0>.",
    "checks.step_answer_has_formatting":
      "The answer for step {{number}} of \"{{story}}\" uses {{kinds}}, but answers are text only.",
    "checks.answer_format_list": "lists",
    "checks.answer_format_heading": "headings",
    "checks.answer_format_blockquote": "block quotes",
    "checks.answer_format_rule": "horizontal rules",
  } as Record<string, string>,
}));

function interpolate(text: string, values?: Record<string, unknown>): string {
  if (!values) return text;
  let out = text;
  for (const [k, v] of Object.entries(values)) {
    out = out.replace(`{{${k}}}`, String(v));
  }
  return out;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // Key-passthrough; interpolate {{params}} so we can assert no empty slug.
      const base = FIXTURE_STRINGS[key] ?? key;
      if (opts && Object.keys(opts).length > 0) {
        return interpolate(base, opts);
      }
      return base;
    },
    i18n: { language: language.current },
  }),
}));

import { ValidationChecks } from "~/components/features/publish/ValidationChecks";

const CANONICAL_KEYS = [
  "passed_checks.object_metadata",
  "passed_checks.term_links",
  "passed_checks.iiif_tiles",
  "passed_checks.site_url",
  "passed_checks.telar_version",
];

function renderChecks(
  validation: Parameters<typeof ValidationChecks>[0]["validation"],
  workflowRepair?: Parameters<typeof ValidationChecks>[0]["workflowRepair"],
) {
  return render(
    <MemoryRouter>
      <ValidationChecks validation={validation} workflowRepair={workflowRepair} />
    </MemoryRouter>,
  );
}

describe("'What we checked' passed-checks numbered list", () => {
  it("renders the canonical passed-check labels as a numbered list when nothing fails", () => {
    renderChecks({ blockers: [], warnings: [] });
    for (const key of CANONICAL_KEYS) {
      expect(screen.getByText(key)).toBeTruthy();
    }
    // Numbered list: an <ol> wraps the passed checks, one <li> per check.
    const items = document.querySelectorAll("ol li");
    expect(items.length).toBe(CANONICAL_KEYS.length);
  });

  it("omits a check whose failing code appears in validation (passed = canonical set minus failures)", () => {
    // object_no_title warning suppresses the object_metadata passed-check.
    renderChecks({
      blockers: [],
      warnings: [{ code: "object_no_title", message: "object_no_title", entityId: "obj-1", params: { id: "obj-1" } }],
    });
    expect(screen.queryByText("passed_checks.object_metadata")).toBeNull();
    // The other four canonical checks (no validation code) still pass.
    expect(screen.getByText("passed_checks.term_links")).toBeTruthy();
    expect(screen.getByText("passed_checks.iiif_tiles")).toBeTruthy();
    expect(screen.getByText("passed_checks.site_url")).toBeTruthy();
    expect(screen.getByText("passed_checks.telar_version")).toBeTruthy();
    // And the warning itself renders.
    expect(screen.getByText("checks.object_no_title")).toBeTruthy();
  });
});

describe("reworded page_no_title blocker renders without an empty quote", () => {
  it("renders the recovery-oriented page_no_title copy and contains no empty 'Page \"\"' quote", () => {
    renderChecks({
      blockers: [{ code: "page_no_title", message: "page_no_title", entityId: "untitled-1" }],
      warnings: [],
    });
    // The reworded blocker is keyed by `checks.page_no_title` and takes no
    // params — so no slug is interpolated and no empty `Page ""` is rendered.
    expect(screen.getByText("checks.page_no_title")).toBeTruthy();
    expect(document.body.textContent).not.toContain('Page ""');
    expect(document.body.textContent).not.toContain("{{slug}}");
  });
});

describe("warnings that carry a docs link", () => {
  const EN_URL = "https://telar.org/docs/setup/upgrading/#v160-upgrade-notes";
  const ES_URL =
    "https://telar.org/guia/configuracion/actualizacion/#notas-de-actualización-a-v160";

  const staleWorkflowWarning = {
    blockers: [],
    warnings: [
      {
        code: "private_story_workflow_stale",
        message: "private_story_workflow_stale",
        params: { stories: "The Weavers, untitled-priv" },
      },
    ],
  };

  afterEach(() => {
    language.current = "en";
  });

  it("names the affected stories inside the warning", () => {
    renderChecks(staleWorkflowWarning);
    expect(document.body.textContent).toContain("The Weavers, untitled-priv");
    expect(document.body.textContent).not.toContain("{{stories}}");
  });

  it("renders the <0> segment as the link text", () => {
    renderChecks(staleWorkflowWarning);
    const link = screen.getByText("The upgrade notes explain how.").closest("a");
    expect(link).not.toBeNull();
  });

  it("points at the English docs page under an English UI language", () => {
    language.current = "en";
    renderChecks(staleWorkflowWarning);
    const link = screen.getByText("The upgrade notes explain how.").closest("a");
    expect(link?.getAttribute("href")).toBe(EN_URL);
  });

  it("points at the Spanish docs page under es-CO", () => {
    language.current = "es-CO";
    renderChecks(staleWorkflowWarning);
    const link = screen.getByText("The upgrade notes explain how.").closest("a");
    expect(link?.getAttribute("href")).toBe(ES_URL);
  });

  it("opens the docs page in a new tab without handing it the opener", () => {
    renderChecks(staleWorkflowWarning);
    const link = screen.getByText("The upgrade notes explain how.").closest("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders no anchor for a warning with no docs-link entry", () => {
    renderChecks({
      blockers: [],
      warnings: [
        {
          code: "private_story_no_key",
          message: "private_story_no_key",
          params: { stories: "The Weavers" },
        },
      ],
    });
    expect(document.body.textContent).toContain("The Weavers");
    expect(document.querySelectorAll("a").length).toBe(0);
  });
});

describe("the repair button under the stale-workflow warning", () => {
  const staleWorkflow = {
    blockers: [],
    warnings: [
      {
        code: "private_story_workflow_stale",
        message: "private_story_workflow_stale",
        params: { stories: "The Weavers" },
      },
    ],
  };
  const noKey = {
    blockers: [],
    warnings: [
      {
        code: "private_story_no_key",
        message: "private_story_no_key",
        params: { stories: "The Weavers" },
      },
    ],
  };

  const repair = (
    status:
      | "idle"
      | "running"
      | "done"
      | "permission"
      | "permission_convenor_required"
      | "stale"
      | "failed",
    reauthUrl: string | null = null,
  ) => ({ status, reauthUrl, onRepair: vi.fn() });

  it("renders no button when the page passes no repair prop", () => {
    renderChecks(staleWorkflow);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the button inside the stale-workflow warning", () => {
    renderChecks(staleWorkflow, repair("idle"));
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("checks.workflow_repair_action");
    // Inside the warning's own box, not loose in the section.
    expect(button.closest("div")?.textContent).toContain("the workflow is stale");
  });

  it("renders no button under a warning the repair cannot fix", () => {
    renderChecks(noKey, repair("idle"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("disables the button and switches its label while the repair runs", () => {
    renderChecks(staleWorkflow, repair("running"));
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("checks.workflow_repair_running");
  });

  it("asks the page to repair when pressed", () => {
    const prop = repair("idle");
    renderChecks(staleWorkflow, prop);
    screen.getByRole("button").click();
    expect(prop.onRepair).toHaveBeenCalledTimes(1);
  });
});

describe("the repair status line, which outlives the warning", () => {
  const repaired = (
    status: "done" | "permission" | "permission_convenor_required" | "stale" | "failed",
    reauthUrl: string | null = null,
  ) => ({ status, reauthUrl, onRepair: vi.fn() });

  it("keeps the done line after the re-run empties the warnings", () => {
    renderChecks({ blockers: [], warnings: [] }, repaired("done"));
    expect(screen.getByText("checks.workflow_repair_done")).toBeTruthy();
  });

  it("says nothing before a repair has been asked for", () => {
    renderChecks({ blockers: [], warnings: [] }, {
      status: "idle",
      reauthUrl: null,
      onRepair: vi.fn(),
    });
    expect(screen.queryByText("checks.workflow_repair_done")).toBeNull();
    expect(screen.queryByText("checks.workflow_repair_failed")).toBeNull();
  });

  it("renders the failure line", () => {
    renderChecks({ blockers: [], warnings: [] }, repaired("failed"));
    expect(screen.getByText("checks.workflow_repair_failed")).toBeTruthy();
  });

  it("renders the stale-head line with its re-sync link", () => {
    renderChecks({ blockers: [], warnings: [] }, repaired("stale"));
    expect(screen.getByText("checks.stale_head")).toBeTruthy();
    const link = screen.getByText("checks.stale_head_action").closest("a");
    expect(link?.getAttribute("href")).toBe("/objects?sync=1");
  });

  it("links the permission line to the installation settings page, in a new tab", () => {
    renderChecks(
      { blockers: [], warnings: [] },
      repaired("permission", "https://github.com/settings/installations/42"),
    );
    const link = screen.getByText("Review the app's permissions").closest("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/settings/installations/42");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("offers no link when the caller cannot act on the settings page", () => {
    // The App's installation settings can only be worked by the account that
    // installed it. Handing the link to anyone else names a remedy they
    // cannot perform, so this state carries the message and nothing to click.
    const { container } = renderChecks(
      { blockers: [], warnings: [] },
      repaired("permission_convenor_required"),
    );
    expect(
      screen.getByText("checks.workflow_repair_permission_convenor_required"),
    ).toBeTruthy();
    expect(container.querySelectorAll("a").length).toBe(0);
  });

  it("still offers the link to a caller who can act on it", () => {
    // The pair matters more than either half: if this one stopped linking,
    // the convenor would lose the only route to the grant.
    const { container } = renderChecks(
      { blockers: [], warnings: [] },
      repaired("permission", "https://github.com/settings/installations/42"),
    );
    expect(container.querySelectorAll("a").length).toBe(1);
  });

  it("renders the status line below the warnings block", () => {
    const { container } = renderChecks(
      {
        blockers: [],
        warnings: [
          {
            code: "private_story_workflow_stale",
            message: "private_story_workflow_stale",
            params: { stories: "The Weavers" },
          },
        ],
      },
      repaired("done"),
    );
    const text = container.textContent ?? "";
    expect(text.indexOf("the workflow is stale")).toBeLessThan(
      text.indexOf("checks.workflow_repair_done"),
    );
  });
});

// ---------------------------------------------------------------------------
// The rebuild the repair's commit starts. The repair owns the only place it is
// shown, so the `done` line has four more things it can say.
// ---------------------------------------------------------------------------

describe("the status line follows the repair's own rebuild", () => {
  type Build = NonNullable<Parameters<typeof ValidationChecks>[0]["workflowRepair"]>["build"];

  const withBuild = (build: Build) => ({
    status: "done" as const,
    reauthUrl: null,
    build,
    onRepair: vi.fn(),
  });

  const RUN_URL = "https://github.com/owner/repo/actions/runs/42";

  it("says the workflow is up to date and nothing more before the first poll answers", () => {
    renderChecks({ blockers: [], warnings: [] }, withBuild(null));
    expect(screen.getByText("checks.workflow_repair_done")).toBeTruthy();
    expect(screen.queryByText("checks.workflow_repair_building")).toBeNull();
  });

  it("says the rebuild could not be checked just now, only while the poll is unanswered", () => {
    const unchecked = { ...withBuild({ state: "building", buildUrl: null }), buildUnchecked: true };
    const { unmount } = renderChecks({ blockers: [], warnings: [] }, unchecked);
    expect(screen.getByText("checks.workflow_repair_build_unchecked")).toBeTruthy();
    unmount();
    renderChecks({ blockers: [], warnings: [] }, withBuild({ state: "building", buildUrl: null }));
    expect(screen.queryByText("checks.workflow_repair_build_unchecked")).toBeNull();
  });

  it("says the site is rebuilding, and links to the run once GitHub names it", () => {
    const { container } = renderChecks(
      { blockers: [], warnings: [] },
      withBuild({ state: "building", buildUrl: RUN_URL }),
    );
    expect(screen.getByText("checks.workflow_repair_building")).toBeTruthy();
    const link = screen.getByText("checks.workflow_repair_watch").closest("a");
    expect(link?.getAttribute("href")).toBe(RUN_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    // The sentence and the link are separate words, not one run-on string.
    expect(container.textContent).toContain(
      "checks.workflow_repair_building checks.workflow_repair_watch",
    );
  });

  it("offers no watch link while the run has no URL yet", () => {
    renderChecks({ blockers: [], warnings: [] }, withBuild({ state: "building", buildUrl: null }));
    expect(screen.getByText("checks.workflow_repair_building")).toBeTruthy();
    expect(screen.queryByText("checks.workflow_repair_watch")).toBeNull();
  });

  it("says the site has been rebuilt, with no link — the site is the result", () => {
    const { container } = renderChecks(
      { blockers: [], warnings: [] },
      withBuild({ state: "rebuilt", buildUrl: RUN_URL }),
    );
    expect(screen.getByText("checks.workflow_repair_rebuilt")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
  });

  it("links the failed line to the run", () => {
    renderChecks({ blockers: [], warnings: [] }, withBuild({ state: "failed", buildUrl: RUN_URL }));
    const link = screen.getByText("See the build details").closest("a");
    expect(link?.getAttribute("href")).toBe(RUN_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("links the cancelled line to the run", () => {
    const { container } = renderChecks(
      { blockers: [], warnings: [] },
      withBuild({ state: "cancelled", buildUrl: RUN_URL }),
    );
    expect(container.textContent).toContain("the rebuild was cancelled");
    const link = screen.getByText("See the build details").closest("a");
    expect(link?.getAttribute("href")).toBe(RUN_URL);
  });

  it("still says what happened when there is no run to link to", () => {
    for (const state of ["failed", "cancelled"] as const) {
      const { container, unmount } = renderChecks(
        { blockers: [], warnings: [] },
        withBuild({ state, buildUrl: null }),
      );
      expect(screen.getByText("See the build details")).toBeTruthy();
      expect(container.querySelector("a")).toBeNull();
      unmount();
    }
  });
});

describe("stale_head blocker action link", () => {
  it("deep-links to the Objects-page sync review flow", () => {
    renderChecks({
      blockers: [{ code: "stale_head", message: "stale_head" }],
      warnings: [],
    });
    const link = screen.getByText("checks.stale_head_action").closest("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/objects?sync=1");
  });
});

describe("a warning that names the formatting an answer uses", () => {
  // The check emits kind KEYS, because it runs on the server with no locale.
  // Nothing else in this file renders one, so a page that handed i18next the
  // raw keys would read "uses list,heading" and no test would say so.
  it("renders each kind by its name, not by its key", () => {
    renderChecks({
      blockers: [],
      warnings: [
        {
          code: "step_answer_has_formatting",
          message: "step_answer_has_formatting",
          entityId: "7",
          params: { number: "3", story: "The Weavers", kinds: ["list", "heading"] },
        },
      ],
    });

    const line = screen.getByText(/uses/);
    expect(line.textContent).toContain("lists");
    expect(line.textContent).toContain("headings");
    expect(line.textContent).not.toContain("list,heading");
  });
});

describe("a title that looks like interpolation syntax", () => {
  const TITLE = "{{count}} <img src=x>";

  it("renders literally in an ordinary warning, with no character added", () => {
    renderChecks({
      blockers: [],
      warnings: [
        {
          code: "private_story_no_key",
          message: "private_story_no_key",
          entityId: "s1",
          params: { stories: TITLE },
        },
      ],
    });

    const line = screen.getByText(/private/);
    expect(line.textContent).toContain(TITLE);
    expect(line.textContent).not.toContain("\u200b");
    expect(line.textContent).not.toContain("\u0000");
  });

  // A private story's title reaches this one, whose copy carries a docs link.
  // The link is the catalogue's own `<0>` segment, split off before the
  // authored values return, so the title beside it is text like any other.
  it("renders literally in a warning that carries a link, and keeps the link", () => {
    renderChecks({
      blockers: [],
      warnings: [
        {
          code: "private_story_workflow_stale",
          message: "private_story_workflow_stale",
          entityId: "s1",
          params: { stories: TITLE },
        },
      ],
    });

    const link = screen.getByRole("link", { name: /upgrade notes/i });
    expect(link).toBeTruthy();
    const line = link.closest("p");
    expect(line?.textContent).toContain(TITLE);
    expect(line?.textContent).not.toContain("\u0000");
  });
});

describe("the page front-matter blocker", () => {
  const blocker = {
    code: "page_frontmatter_unwritable",
    message: "page_frontmatter_unwritable",
    entityId: "acerca",
    params: { page: "Sobre" },
  };

  it("offers to keep only the title, and the control names the page by slug", async () => {
    const onReset = vi.fn();
    render(
      <MemoryRouter>
        <ValidationChecks validation={{ blockers: [blocker], warnings: [] }} onResetPageFrontmatter={onReset} />
      </MemoryRouter>,
    );
    screen.getByRole("button", { name: "checks.page_frontmatter_reset" }).click();
    expect(onReset).toHaveBeenCalledWith("acerca");
  });

  it("renders without the control where the page offers no reset", () => {
    renderChecks({ blockers: [blocker], warnings: [] });
    expect(screen.queryByRole("button", { name: "checks.page_frontmatter_reset" })).toBeNull();
  });

  it("says when a reset did not happen, with the blocker still in the list", () => {
    render(
      <MemoryRouter>
        <ValidationChecks
          validation={{ blockers: [blocker], warnings: [] }}
          resetFailed={{ page: "acerca" }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert").textContent).toBe("checks.page_frontmatter_reset_failed");
    expect(screen.getByText("checks.page_frontmatter_unwritable")).toBeTruthy();
  });

  it("says nothing when no reset failed", () => {
    render(
      <MemoryRouter>
        <ValidationChecks validation={{ blockers: [blocker], warnings: [] }} resetFailed={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
