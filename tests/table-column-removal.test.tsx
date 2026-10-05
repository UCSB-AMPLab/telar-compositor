// @vitest-environment jsdom
/**
 * The removal an object or glossary reserved-column blocker offers: the
 * blocker's control and count, the document write that takes the column off
 * every object, and the confirmation that names what is lost.
 *
 * The glossary removal is a D1 write inside the collaboration object, pinned
 * in `tests/workers/table-extra-columns`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { createInstance, type i18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import * as Y from "yjs";

import { removeObjectColumn } from "~/lib/story-columns";
import { applyCustomBlob, customFieldsBlob, customFieldBases } from "~/lib/object-custom-map";
import { ValidationChecks } from "~/components/features/publish/ValidationChecks";
import { runPrePublishValidation } from "~/lib/publish.server";
import enPublish from "~/i18n/locales/en/publish.json";

const j = (o: Record<string, string>) => JSON.stringify(o);

function objectsDoc(blobs: Record<string, string>): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const [id, blob] of Object.entries(blobs)) {
      const map = new Y.Map<unknown>();
      doc.getArray<Y.Map<unknown>>("objects").push([map]);
      map.set("object_id", id);
      applyCustomBlob(map, blob);
    }
  });
  return doc;
}

const written = (doc: Y.Doc) => {
  const objects = doc.getArray<Y.Map<unknown>>("objects");
  return objects.toArray().map((m) => customFieldsBlob(m, () => customFieldBases(objects)));
};

function blockersFor(objects: Array<{ object_id: string; title?: string; extra_columns: string | null }>, glossary: Array<{ term_id: string; extra_columns: string | null }> = []) {
  return runPrePublishValidation({
    headSha: "a", currentRepoHead: "a", stories: [], steps: [], objects: objects.map((o) => ({ title: "T", ...o })), pages: [], glossary,
  }).blockers.filter((b) => b.code.endsWith("_reserved_column"));
}

describe("removeObjectColumn", () => {
  it("takes the column off every object and keeps the others", () => {
    const doc = objectsDoc({
      a: j({ _metadata: "x", nota: "n" }),
      b: j({ _metadata: "" }),
      c: j({ nota: "m" }),
    });
    expect(removeObjectColumn(doc, "_metadata")).toBe(2);
    expect(written(doc)).toEqual([j({ nota: "n" }), "{}", j({ nota: "m" })]);
  });

  it("removes a column no object holds a value for, and does nothing twice", () => {
    const doc = objectsDoc({ a: j({ _metadata: "" }), b: j({ _metadata: "" }) });
    expect(removeObjectColumn(doc, "_metadata")).toBe(2);
    expect(removeObjectColumn(doc, "_metadata")).toBe(0);
    expect(written(doc)).toEqual(["{}", "{}"]);
  });

  it("clears the blocker on the next check", () => {
    const doc = objectsDoc({ a: j({ _metadata: "x" }), b: j({ _metadata: "y" }) });
    const rows = () => written(doc).map((blob, i) => ({ object_id: `o${i}`, extra_columns: blob }));
    expect(blockersFor(rows())).toHaveLength(2);
    removeObjectColumn(doc, "_metadata");
    expect(blockersFor(rows())).toEqual([]);
  });
});

describe("the blockers' removal", () => {
  it("is offered once per column, counting the rows that hold a value", () => {
    const blockers = blockersFor(
      [
        { object_id: "a", extra_columns: j({ _metadata: "x" }) },
        { object_id: "b", extra_columns: j({ _metadata: "" }) },
        { object_id: "c", extra_columns: j({ _metadata: "z" }) },
      ],
      [{ term_id: "g", extra_columns: j({ _metadata: "" }) }],
    );
    expect(blockers.map((b) => [b.code, b.entityId, b.removable])).toEqual([
      ["object_reserved_column", "a", { table: "objects", columns: ["_metadata"], rows: { _metadata: 2 } }],
      ["object_reserved_column", "b", undefined],
      ["object_reserved_column", "c", undefined],
      ["glossary_reserved_column", "g", { table: "glossary", columns: ["_metadata"], rows: { _metadata: 0 } }],
    ]);
  });
});

describe("the confirmation", () => {
  let instance: i18n;
  beforeAll(async () => {
    instance = createInstance();
    await instance.use(initReactI18next).init({
      lng: "en", fallbackLng: "en", ns: ["publish"], defaultNS: "publish",
      resources: { en: { publish: enPublish } }, interpolation: { escapeValue: false },
    });
  });
  afterEach(cleanup);

  const blocker = {
    code: "glossary_reserved_column",
    message: "glossary_reserved_column",
    entityId: "g",
    params: { id: "g", column: "_metadata" },
    removable: { table: "glossary" as const, columns: ["_metadata"], rows: { _metadata: 4 } },
  };

  const show = (onRemove = vi.fn()) => {
    render(
      <I18nextProvider i18n={instance}>
        <MemoryRouter>
          <ValidationChecks validation={{ blockers: [blocker], warnings: [] }} onRemoveColumn={onRemove} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    return onRemove;
  };

  it("names the column and the rows holding a value, and removes only when confirmed", () => {
    const onRemove = show();
    fireEvent.click(screen.getByRole("button", { name: 'Remove "_metadata" from every glossary term' }));
    expect(screen.getByText('Removing "_metadata" deletes its values. Rows that hold a value in it: 4. You can\'t undo this.')).toBeTruthy();
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove the column" }));
    expect(onRemove).toHaveBeenCalledWith(blocker.removable, "_metadata");
  });

  it("leaves the column alone on cancel", () => {
    const onRemove = show();
    fireEvent.click(screen.getByRole("button", { name: 'Remove "_metadata" from every glossary term' }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: 'Remove "_metadata" from every glossary term' })).toBeTruthy();
  });
});
