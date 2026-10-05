// @vitest-environment jsdom
/**
 * What the objects-tab sync dialog reads, resolved against the catalogues.
 *
 * Three of the dialog's sentences are catalogue strings: the two labels on a
 * changed field's before/after row, and the warning naming the steps a missing
 * object would strand. The warning's list is the object detail page's
 * `used_in_step`, not a template of the dialog's own — one screen's wording for
 * one thing, in one place.
 *
 * The assertions are about the rendered sentence rather than the key, because a
 * key-echoing `t` cannot tell `used_in_step` filled with the right fallback from
 * the same key filled with a different one, and cannot see plural selection at
 * all. `catalogueT` resolves against the shipped files, so a missing key, a
 * wrong plural form or a changed string fails here.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { SyncDiff, SyncField } from "~/lib/sync.server";
import type { CatalogueLanguage } from "./helpers/catalogue-translator";

/** The locale the next render reads; each test sets it before rendering. */
let language: CatalogueLanguage = "en";

vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  return { useTranslation: () => ({ t: catalogueT("objects", language) }) };
});

import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";

afterEach(() => {
  cleanup();
  language = "en";
});

function emptyDiff(): SyncDiff {
  return { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null };
}

function changedObject(fields: SyncField[]) {
  return {
    object_id: "mapa-de-santafe",
    dbId: 1,
    title: "Mapa de Santafé",
    changedFields: fields,
    conflictFields: [] as SyncField[],
    d1Values: Object.fromEntries(fields.map((f) => [f, `mine-${f}`])),
    repoValues: Object.fromEntries(fields.map((f) => [f, `repo-${f}`])),
  };
}

type StoryUse = { storyTitle: string | null; stepNumber: number };

function missingObject(usedByStories: StoryUse[]) {
  return { object_id: "mapa-de-santafe", dbId: 2, title: "Mapa de Santafé", usedByStories };
}

function renderDialog(diffData: SyncDiff) {
  return render(
    <SyncDiffDialog
      open
      onClose={() => {}}
      diffData={diffData}
      onApply={() => {}}
      isComputing={false}
      isApplying={false}
    />,
  );
}

describe("SyncDiffDialog — the before/after labels on a changed field", () => {
  it("names the compositor's value and the repo's from the catalogue", () => {
    const diff = emptyDiff();
    diff.changedObjects = [changedObject(["title"])];
    renderDialog(diff);

    expect(screen.queryByText("Current:")).not.toBeNull();
    expect(screen.queryByText("Repo:")).not.toBeNull();
  });

  it("reads the Spanish pair, which names the compositor rather than 'current'", () => {
    // The Spanish is not a word-for-word pair with the English: an author sees
    // "Compositor:" against "Repositorio:", and an English-shaped "Actual:"
    // would satisfy any key-echoing assertion.
    language = "es";
    const diff = emptyDiff();
    diff.changedObjects = [changedObject(["title"])];
    renderDialog(diff);

    expect(screen.queryByText("Compositor:")).not.toBeNull();
    expect(screen.queryByText("Repositorio:")).not.toBeNull();
  });
});

describe("SyncDiffDialog — the sheet a missing object may have been deleted from", () => {
  it("names the file the sync read, objetos.csv on a Spanish-only site", () => {
    const diff = emptyDiff();
    diff.objectsSheet = "objetos.csv";
    diff.missingObjects = [missingObject([])];
    const { baseElement } = renderDialog(diff);

    expect(baseElement.textContent).toContain("They may have been deleted from objetos.csv.");
  });
});

describe("SyncDiffDialog — the steps a missing object would strand", () => {
  it("uses the singular lead for one step", () => {
    const diff = emptyDiff();
    diff.missingObjects = [missingObject([{ storyTitle: "El río", stepNumber: 3 }])];
    renderDialog(diff);

    expect(
      screen.queryByText("One step uses this object and will be left without it:"),
    ).not.toBeNull();
  });

  it("uses the plural lead, carrying the count, for more than one step", () => {
    const diff = emptyDiff();
    diff.missingObjects = [
      missingObject([
        { storyTitle: "El río", stepNumber: 3 },
        { storyTitle: "La cordillera", stepNumber: 1 },
      ]),
    ];
    renderDialog(diff);

    expect(
      screen.queryByText("2 steps use this object and will be left without it:"),
    ).not.toBeNull();
  });

  it("renders one list entry per step, in the object page's own wording", () => {
    const diff = emptyDiff();
    diff.missingObjects = [
      missingObject([
        { storyTitle: "El río", stepNumber: 3 },
        { storyTitle: "La cordillera", stepNumber: 1 },
      ]),
    ];
    const { baseElement: container } = renderDialog(diff);

    const entries = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
    expect(entries).toEqual(["El río — step 3", "La cordillera — step 1"]);
    // `(step N)` is what a template built here produces; `used_in_step` never
    // parenthesises. Its absence is the assertion that the list is the shared one.
    expect(container.textContent).not.toContain("(step ");
  });

  it("names a story with no title from the shared story fallback", () => {
    const diff = emptyDiff();
    diff.missingObjects = [missingObject([{ storyTitle: null, stepNumber: 2 }])];
    const { baseElement: container } = renderDialog(diff);

    expect(screen.queryByText("Untitled story — step 2")).not.toBeNull();
    // `Untitled` alone is `common:untitled`, which labels objects and pages
    // too; a story needs the noun or the entry reads as a missing object.
    expect(container.textContent).not.toContain("unnamed story");
  });
});
