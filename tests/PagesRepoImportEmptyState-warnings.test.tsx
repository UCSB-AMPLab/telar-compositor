// @vitest-environment jsdom
/**
 * The Pages tab's import state names each page whose file the scan could not
 * read as valid UTF-8, above the pages to import, so the file is named before
 * the import stores it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { SheetWarning } from "~/lib/sheet-warnings";

vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  return { useTranslation: (ns?: string) => ({ t: catalogueT(ns ?? "common", "en") }) };
});

import { PagesRepoImportEmptyState } from "~/components/features/pages/PagesEmptyState";

afterEach(cleanup);

const WARNING: SheetWarning = {
  code: "unreadable_characters",
  file: "telar-content/texts/pages/about.md",
  effect: "build_stops",
  repair: "import_then_publish",
};

function renderState(warnings?: SheetWarning[]) {
  return render(
    <PagesRepoImportEmptyState
      pages={[{ slug: "about", title: "About" }]}
      warnings={warnings}
      onImportAll={() => {}}
      onImportOne={() => {}}
      isImporting={false}
      importingSlugs={new Set()}
    />,
  );
}

describe("PagesRepoImportEmptyState", () => {
  it("shows the scan's warnings above the pages to import", () => {
    const { container } = renderState([WARNING]);
    const sentence = screen.getByText(
      'The file "telar-content/texts/pages/about.md" has characters your site can\'t read, so your site can\'t update. ' +
        "If you import this page, your next publish replaces them with �.",
    );
    const pageRow = screen.getByText("about");
    // The warning comes first in the document.
    expect(sentence.compareDocumentPosition(pageRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("shows no warning list without warnings", () => {
    const { container } = renderState();
    expect(container.querySelector("details")).toBeNull();
  });
});
