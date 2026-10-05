// @vitest-environment jsdom
/**
 * The removal a story column blocker offers on the publish page: the document
 * write that takes a kept column off every step of one story, and the control
 * that asks for it.
 *
 * The blocker clearing is read the way the page reads it: steps as the next
 * snapshot would write them to D1, through `runPrePublishValidation`. The
 * collaboration object's route that runs the write and the snapshot is
 * `tests/workers/story-extra-columns`, and the action that calls it is
 * `tests/story-csv-passthrough`.
 *
 * The control renders through the real i18next and the real catalogues, so
 * the label under test is the one an author reads.
 *
 * The failure line this blocker renders on a failed removal shares its
 * component with the one a failed page front-matter reset renders, so both
 * are pinned against the real catalogues here.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { createInstance, type i18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import * as Y from "yjs";

import { removeStoryColumns } from "~/lib/story-columns";
import { ValidationChecks } from "~/components/features/publish/ValidationChecks";
import { runPrePublishValidation, type StepForValidation } from "~/lib/publish.server";
import enPublish from "~/i18n/locales/en/publish.json";
import esPublish from "~/i18n/locales/es/publish.json";

/** A document holding `stories`, each a story_id and its steps' blobs. */
function docWith(stories: Record<string, Array<string | undefined>>): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const [storyId, blobs] of Object.entries(stories)) {
      const story = new Y.Map<unknown>();
      const steps = new Y.Array<Y.Map<unknown>>();
      story.set("story_id", storyId);
      story.set("title", new Y.Text(`Title of ${storyId}`));
      story.set("steps", steps);
      doc.getArray<Y.Map<unknown>>("stories").push([story]);
      blobs.forEach((blob, i) => {
        const step = new Y.Map<unknown>();
        step.set("_id", i + 1);
        step.set("step_number", i + 1);
        if (blob !== undefined) step.set("extra_columns", blob);
        steps.push([step]);
      });
    }
  });
  return doc;
}

function blobsOf(doc: Y.Doc, storyId: string): unknown[] {
  const story = doc.getArray<Y.Map<unknown>>("stories").toArray().find((s) => s.get("story_id") === storyId)!;
  return (story.get("steps") as Y.Array<Y.Map<unknown>>).toArray().map((m) => m.get("extra_columns"));
}

/** The steps as the snapshot writes them to D1 and the page's check reads them. */
function stepsForValidation(doc: Y.Doc): StepForValidation[] {
  return doc.getArray<Y.Map<unknown>>("stories").toArray().flatMap((story) =>
    (story.get("steps") as Y.Array<Y.Map<unknown>>).toArray().map((step) => {
      const blob = step.get("extra_columns");
      return {
        id: step.get("_id") as number,
        step_number: step.get("step_number") as number,
        object_id: "obj",
        x: 0.5,
        y: 0.5,
        zoom: 1,
        question: "Q",
        answer: "A",
        story_id: story.get("story_id") as string,
        story_title: String(story.get("title")),
        extra_columns: typeof blob === "string" && blob !== "" ? blob : null,
      };
    }),
  );
}

function storyBlockers(doc: Y.Doc) {
  return runPrePublishValidation({
    headSha: "a",
    currentRepoHead: "a",
    stories: [],
    steps: stepsForValidation(doc),
    objects: [],
    pages: [],
    glossary: [],
  }).blockers.filter((b) => b.code === "story_reserved_column" || b.code === "story_colliding_columns");
}

const j = (o: Record<string, string>) => JSON.stringify(o);

describe("removeStoryColumns", () => {
  it("takes the column off every step of the named story and nowhere else", () => {
    const doc = docWith({
      historia: [j({ _metadata: "a", nota: "n" }), j({ _metadata: "b" }), ""],
      otra: [j({ _metadata: "c" })],
    });

    expect(removeStoryColumns(doc, "historia", ["_metadata"])).toBe(2);
    // A step left with no column records "{}", as distinct from the "" of a
    // step whose columns were never recorded, which is left alone.
    expect(blobsOf(doc, "historia")).toEqual([j({ nota: "n" }), "{}", ""]);
    expect(blobsOf(doc, "otra")).toEqual([j({ _metadata: "c" })]);
  });

  it("clears the blocker on the page's next check", () => {
    const doc = docWith({ historia: [j({ _metadata: "a", Note: "x" }), j({ note: "y" })] });
    expect(storyBlockers(doc).map((b) => b.code).sort()).toEqual([
      "story_colliding_columns",
      "story_reserved_column",
    ]);

    removeStoryColumns(doc, "historia", ["_metadata"]);
    removeStoryColumns(doc, "historia", ["note"]);

    expect(storyBlockers(doc)).toEqual([]);
    expect(blobsOf(doc, "historia")).toEqual([j({ Note: "x" }), "{}"]);
  });

  it("matches the column exactly, as the blocker names it", () => {
    const doc = docWith({ historia: [j({ Note: "x", note: "y" })] });
    removeStoryColumns(doc, "historia", ["Note"]);
    expect(blobsOf(doc, "historia")).toEqual([j({ note: "y" })]);
  });

  it("writes nothing where no step holds the column", () => {
    const doc = docWith({ historia: [j({ nota: "n" }), "", undefined, "not json"] });
    let updates = 0;
    doc.on("update", () => { updates += 1; });

    expect(removeStoryColumns(doc, "historia", ["_metadata"])).toBe(0);
    expect(updates).toBe(0);
    expect(blobsOf(doc, "historia")).toEqual([j({ nota: "n" }), "", undefined, "not json"]);
  });

  it("keeps a column an author named __proto__", () => {
    const doc = docWith({ historia: ['{"__proto__":"p","_metadata":"m"}'] });
    removeStoryColumns(doc, "historia", ["_metadata"]);
    expect(blobsOf(doc, "historia")).toEqual(['{"__proto__":"p"}']);
  });

  it("is one step of the session's undo history", () => {
    const doc = docWith({ historia: [j({ _metadata: "a" }), j({ _metadata: "b" })] });
    const um = new Y.UndoManager(doc.getArray("stories"), { trackedOrigins: new Set([null]) });
    removeStoryColumns(doc, "historia", ["_metadata"]);
    expect(blobsOf(doc, "historia")).toEqual(["{}", "{}"]);
    um.undo();
    expect(blobsOf(doc, "historia")).toEqual([j({ _metadata: "a" }), j({ _metadata: "b" })]);
  });
});

describe("the control on a story column blocker", () => {
  const instances: Record<string, i18n> = {};

  beforeAll(async () => {
    for (const lng of ["en", "es"]) {
      const instance = createInstance();
      await instance.use(initReactI18next).init({
        lng,
        fallbackLng: "en",
        ns: ["publish"],
        defaultNS: "publish",
        resources: { en: { publish: enPublish }, es: { publish: esPublish } },
        interpolation: { escapeValue: false },
      });
      instances[lng] = instance;
    }
  });

  afterEach(cleanup);

  const collision = {
    code: "story_colliding_columns",
    message: "story_colliding_columns",
    entityId: "historia",
    params: { story: "Historia", columns: '"Note", "note"' },
    removable: { table: "steps" as const, storyId: "historia", columns: ["Note", "note"], rows: { Note: 2, note: 0 } },
  };

  function renderChecks(lng: string, onRemove?: (removable: unknown, column: string) => void) {
    render(
      <I18nextProvider i18n={instances[lng]}>
        <MemoryRouter>
          <ValidationChecks
            validation={{ blockers: [collision], warnings: [] }}
            onRemoveColumn={onRemove}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  it("offers one removal per kept column, each naming it in its own case", () => {
    const onRemove = vi.fn();
    renderChecks("en", onRemove);

    expect(
      screen.getByText('Story "Historia" has columns Telar reads as one ("Note", "note"). Remove all but one before publishing, or the site\'s next build will fail.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: 'Remove "note" from this story' }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove the column" }));
    expect(onRemove).toHaveBeenCalledWith(collision.removable, "note");
    expect(screen.getByRole("button", { name: 'Remove "Note" from this story' })).toBeTruthy();
  });

  it("reads in Spanish", () => {
    renderChecks("es", vi.fn());
    expect(screen.getByRole("button", { name: 'Quitar "Note" de esta historia' })).toBeTruthy();
  });

  function renderFailure(lng: string, removalFailed: { column: string } | null) {
    render(
      <I18nextProvider i18n={instances[lng]}>
        <MemoryRouter>
          <ValidationChecks
            validation={{ blockers: [collision], warnings: [] }}
            onRemoveColumn={vi.fn()}
            removalFailed={removalFailed}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  it("says when a removal did not happen, naming the column", () => {
    renderFailure("en", { column: "note" });
    expect(screen.getByRole("alert").textContent).toBe(
      'We couldn\'t remove the column "note". Try again in a moment.',
    );
  });

  it("says it in Spanish", () => {
    renderFailure("es", { column: "note" });
    expect(screen.getByRole("alert").textContent).toBe(
      'No pudimos quitar la columna "note". Intenta de nuevo en un momento.',
    );
  });

  it("says nothing when no removal failed", () => {
    renderFailure("en", null);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is absent where the page offers no removal", () => {
    renderChecks("en");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the page front-matter blocker's reset failure", () => {
  const instances: Record<string, i18n> = {};

  beforeAll(async () => {
    for (const lng of ["en", "es"]) {
      const instance = createInstance();
      await instance.use(initReactI18next).init({
        lng,
        fallbackLng: "en",
        ns: ["publish"],
        defaultNS: "publish",
        resources: { en: { publish: enPublish }, es: { publish: esPublish } },
        interpolation: { escapeValue: false },
      });
      instances[lng] = instance;
    }
  });

  afterEach(cleanup);

  const blocker = {
    code: "page_frontmatter_unwritable",
    message: "page_frontmatter_unwritable",
    entityId: "acerca",
    params: { page: "Sobre" },
  };

  function renderFailure(lng: string, resetFailed: { page: string } | null) {
    render(
      <I18nextProvider i18n={instances[lng]}>
        <MemoryRouter>
          <ValidationChecks
            validation={{ blockers: [blocker], warnings: [] }}
            resetFailed={resetFailed}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );
  }

  it("says when a reset did not happen, naming the page", () => {
    renderFailure("en", { page: "acerca" });
    expect(screen.getByRole("alert").textContent).toBe(
      'We couldn\'t keep only the title in the settings block of page "acerca". Try again in a moment.',
    );
  });

  it("says it in Spanish", () => {
    renderFailure("es", { page: "acerca" });
    expect(screen.getByRole("alert").textContent).toBe(
      'No pudimos conservar solo el título en el bloque de ajustes de la página "acerca". Intenta de nuevo en un momento.',
    );
  });

  it("says nothing when no reset failed", () => {
    renderFailure("en", null);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
