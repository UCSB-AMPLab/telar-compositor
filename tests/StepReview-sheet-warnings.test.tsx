// @vitest-environment jsdom
/**
 * The import's review step writes each sheet warning through
 * `SheetWarnings`, so the first import shows them in the reader's language
 * with the sheet named, rather than as the parser's English.
 *
 * A site the Compositor moved to `main` whose GitHub Pages still publishes
 * from a branch is told so here, naming the branch Pages reports.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ImportResult } from "~/lib/import.server";

vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  return {
    useTranslation: (ns?: string) => ({ t: catalogueT(ns ?? "common", "en") }),
  };
});
vi.mock("~/components/features/onboarding/InlineConfig", () => ({ InlineConfig: () => null }));

import { StepReview } from "~/components/features/onboarding/StepReview";

function result(): ImportResult {
  return {
    valid: true,
    project: { imported: true, storiesFound: 1 },
    objects: {
      imported: 2,
      skipped: 0,
      warnings: [
        { code: "tree_truncated" },
        { code: "ragged_row", row: { label: "obj-002" }, sheet: "objects.csv" },
      ],
    },
    stories: { imported: 1, warnings: [{ code: "page_below_one", step: 3, value: "0", sheet: "story-one.csv" }] },
    glossary: { imported: 0 },
    pages: { imported: 0 },
    themes: { imported: 0, list: [] },
    sheetsEnabled: false,
    sheetsDisabled: false,
    iiifObjectIds: [],
    audioObjectIds: [],
    videoObjectCount: 0,
    configFields: {},
    orphanStoryIds: [],
  };
}

describe("StepReview — sheet warnings", () => {
  it("lists every warning as its sentence, with the review step's count", () => {
    render(
      <MemoryRouter>
        <StepReview
          importResult={result()}
          onDone={() => {}}
          onEditConfig={() => {}}
          showInlineConfig={false}
          projectId={1}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("3 warnings")).toBeTruthy();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("Your repository has more files than GitHub lists at once");
    expect(items[1]).toContain('Row "obj-002" in the sheet "objects.csv"');
    expect(items[2]).toContain('In the sheet "story-one.csv", step 3 has page "0"');
  });
});

describe("StepReview — Pages still publishing from a branch", () => {
  afterEach(cleanup);

  function renderReview(importResult: ImportResult) {
    render(
      <MemoryRouter>
        <StepReview
          importResult={importResult}
          onDone={() => {}}
          onEditConfig={() => {}}
          showInlineConfig={false}
          projectId={1}
        />
      </MemoryRouter>,
    );
  }

  it("names the branch Pages publishes from when the result carries pagesWarning", () => {
    renderReview({ ...result(), pagesWarning: { branch: "gh-pages" } });

    expect(screen.getByRole("alert").textContent).toBe(
      'The site\'s branch is now "main", but GitHub Pages still publishes it from "gh-pages". ' +
        "In the repository's Pages settings on GitHub, choose GitHub Actions as the source.",
    );
  });

  it("shows no Pages notice when the result carries none", () => {
    renderReview(result());

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
