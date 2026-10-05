// @vitest-environment jsdom
/**
 * Concurrent edits to an object's custom fields on the object page both land
 *
 * Each custom field is its own Y.Text in the object's `custom_fields` map, so
 * two copies of the document editing different fields, or typing in the same
 * one, merge instead of one whole-blob write replacing the other. Each case
 * drives the page's own field component in two documents, merges them, and
 * reads the blob the snapshot writes from the merged object
 * (`customFieldsBlob`, which both snapshot binds call; the Durable Object's
 * side is in object-custom-fields-do.test.ts).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
let currentDoc: Y.Doc | null = null;
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: currentDoc,
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    lastEditorByField: new Map(),
  }),
}));

import { ObjectCustomFields } from "~/components/features/objects/ObjectCustomFields";
import { makeObjectYMap } from "~/lib/object-ymap";
import { applyCustomBlob, customFieldBases, customFieldsBlob, customFieldsOf, settleCustomFields } from "~/lib/object-custom-map";

afterEach(() => {
  cleanup();
  currentDoc = null;
});

/** An object as the cold load builds it from D1: `extra_columns` a plain string. */
function loadObject(doc: Y.Doc, id: number, blob: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  doc.transact(() => {
    m.set("_id", id);
    m.set("object_id", `o${id}`);
    m.set("title", new Y.Text(`Object ${id}`));
    m.set("extra_columns", blob);
    doc.getArray<Y.Map<unknown>>("objects").push([m]);
  }, null);
  return m;
}

function copyOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

function mergeInto(target: Y.Doc, ...sources: Y.Doc[]): void {
  for (const source of sources) Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
}

function objectIn(doc: Y.Doc, id: number): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("_id") === id)!;
}

/** Type `value` into one custom field of object 5 on the object page, as an author does. */
function typeCustomField(doc: Y.Doc, key: string, value: string, sheetHeader?: string[]): void {
  currentDoc = doc;
  render(<ObjectCustomFields objectDbId={5} storedBlob={null} objectId="o5" sheetHeader={sheetHeader} />);
  const input = screen.getByLabelText(key);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  cleanup();
}

/** The document as the server's load leaves it (`settleCustomFields`). */
function loadedDoc(blobs: Record<number, string>): Y.Doc {
  const doc = new Y.Doc();
  for (const [id, blob] of Object.entries(blobs)) loadObject(doc, Number(id), blob);
  settleCustomFields(doc);
  return doc;
}

/** The blob the snapshot writes for object `id`. */
function writtenBlob(doc: Y.Doc, id = 5): string {
  return customFieldsBlob(objectIn(doc, id), () => customFieldBases(doc.getArray("objects")));
}

const twoFields = JSON.stringify({ material: "wood", technique: "carved" });

describe("concurrent custom-field edits on the object page", () => {
  it("two people editing different fields of one object both reach the written blob", () => {
    const doc = loadedDoc({ 5: twoFields });
    const a = copyOf(doc);
    const b = copyOf(doc);
    typeCustomField(a, "material", "oak");
    typeCustomField(b, "technique", "inlaid");
    mergeInto(doc, a, b);
    expect(JSON.parse(writtenBlob(doc))).toEqual({ material: "oak", technique: "inlaid" });
    expect(Object.keys(JSON.parse(writtenBlob(doc)))).toEqual(["material", "technique"]);
  });

  it("two people typing in the same field at once both keep their text", () => {
    const doc = loadedDoc({ 5: twoFields });
    const a = copyOf(doc);
    const b = copyOf(doc);
    typeCustomField(a, "material", "oak");
    typeCustomField(b, "material", "pine");
    mergeInto(doc, a, b);
    const material = JSON.parse(writtenBlob(doc)).material as string;
    expect(material).toContain("oak");
    expect(material).toContain("pine");
  });

  it("an edit beside a whole blob from a browser on the previous bundle keeps both once the server's pass runs", () => {
    const doc = loadedDoc({ 5: twoFields });
    const current = copyOf(doc);
    const previous = copyOf(doc);
    typeCustomField(current, "material", "oak");
    // The previous bundle's write: the whole string, from the blob it read.
    objectIn(previous, 5).set("extra_columns", JSON.stringify({ material: "wood", technique: "inlaid" }));
    mergeInto(doc, current, previous);
    settleCustomFields(doc);
    expect(JSON.parse(writtenBlob(doc))).toEqual({ material: "oak", technique: "inlaid" });
  });
});

describe("a column the object had no value in", () => {
  it("two people typing into it at once both keep their text", () => {
    const doc = loadedDoc({ 5: JSON.stringify({ a: "1" }), 6: JSON.stringify({ a: "1", b: "2" }) });
    const first = copyOf(doc);
    const second = copyOf(doc);
    typeCustomField(first, "b", "oak");
    typeCustomField(second, "b", "pine");
    mergeInto(doc, first, second);
    const b = JSON.parse(writtenBlob(doc)).b as string;
    expect(b).toContain("oak");
    expect(b).toContain("pine");
  });
});

describe("an object made in the browser", () => {
  it("carries its map, so its fields can be edited before the server has seen it", () => {
    const doc = new Y.Doc();
    const m = makeObjectYMap({ objectId: "new", extraColumns: '{"x":"1"}', validationState: "valid", origin: "compositor", orderKey: "a0" });
    doc.getArray<Y.Map<unknown>>("objects").push([m]);
    expect(customFieldsOf(m)!.get("x")!.toString()).toBe("1");
  });
});

describe("column order", () => {
  it("writes a column an object lacked where the other objects' blobs put it, not where the map took it", () => {
    const doc = loadedDoc({ 5: JSON.stringify({ a: "1", c: "3" }), 6: JSON.stringify({ a: "1", b: "2", c: "3" }) });
    const a = copyOf(doc);
    typeCustomField(a, "b", "new");
    mergeInto(doc, a);
    expect(Object.keys(JSON.parse(writtenBlob(doc)))).toEqual(["a", "b", "c"]);
  });

  it("lists the fields in the sheet header's order, whatever order the map holds them in", () => {
    const doc = new Y.Doc();
    const m = loadObject(doc, 5, JSON.stringify({ c: "3", a: "1" }));
    doc.transact(() => applyCustomBlob(m, JSON.stringify({ c: "3", a: "1" })));
    currentDoc = doc;
    render(<ObjectCustomFields objectDbId={5} storedBlob={null} objectId="o5" sheetHeader={["object_id", "a", "c"]} />);
    expect(screen.getAllByRole("textbox").map((el) => (el as HTMLInputElement).labels?.[0]?.textContent)).toEqual(["a", "c"]);
  });

  it("gives each object an empty entry for every column, which writes nothing", () => {
    const doc = loadedDoc({ 5: JSON.stringify({ a: "1" }), 6: JSON.stringify({ a: "1", b: "2" }) });
    expect(customFieldsOf(objectIn(doc, 5))!.get("b")!.toString()).toBe("");
    expect(writtenBlob(doc)).toBe(objectIn(doc, 5).get("extra_columns"));
  });

  it("leaves a column read-only only until the server's pass gives this object its entry, and makes none itself", () => {
    const doc = loadedDoc({ 5: JSON.stringify({ a: "1" }) });
    loadObject(doc, 6, JSON.stringify({ a: "1", c: "3" }));
    // Object 6's blob has reached the document; the server's pass has not run.
    doc.transact(() => applyCustomBlob(objectIn(doc, 6), JSON.stringify({ a: "1", c: "3" })));
    currentDoc = doc;
    render(<ObjectCustomFields objectDbId={5} storedBlob={null} objectId="o5" />);
    const before = screen.getByLabelText("c") as HTMLInputElement;
    fireEvent.focus(before);
    expect(before.disabled).toBe(true);
    expect(customFieldsOf(objectIn(doc, 5))!.has("c")).toBe(false);
    act(() => {
      settleCustomFields(doc);
    });
    expect((screen.getByLabelText("c") as HTMLInputElement).disabled).toBe(false);
  });

  it("shows the stored values read-only where the document has no map for the object", () => {
    const doc = new Y.Doc();
    loadObject(doc, 5, JSON.stringify({ material: "wood" }));
    currentDoc = doc;
    render(<ObjectCustomFields objectDbId={5} storedBlob={null} objectId="o5" />);
    const input = screen.getByLabelText("material") as HTMLInputElement;
    expect(input.value).toBe("wood");
    expect(input.disabled).toBe(true);
  });
});
