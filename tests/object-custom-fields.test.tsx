// @vitest-environment jsdom
/**
 * The object page shows each custom column of the sheet as a text field, in
 * the sheet's order, and edits one through the document; publish writes the
 * columns in the order the file already has.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import * as Y from "yjs";
import Papa from "papaparse";
import { customColumnOrder } from "~/lib/object-custom-fields";
import { customFieldBases, customFieldsBlob, customFieldsOf, settleCustomFields } from "~/lib/object-custom-map";
import { readObjectsSheetHeader, readProjectObjectsHeader } from "~/lib/objects-sheet-header.server";
import { serializeObjectsCsv, type ObjectRow } from "~/lib/csv-export.server";

let currentDoc: Y.Doc | null = null;
let publishing = false;

const resolveToken = vi.hoisted(() => vi.fn());
const readAtRef = vi.hoisted(() => vi.fn());
const installationToken = vi.hoisted(() => vi.fn());
vi.mock("~/lib/github-app.server", () => ({ resolveProjectToken: resolveToken, getInstallationToken: installationToken }));
vi.mock("~/lib/github.server", () => ({ getFileAtRef: readAtRef }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: currentDoc,
    isPublishing: publishing,
    remoteCollaborators: [],
    provider: null,
    lastEditorByField: new Map(),
  }),
}));

import { ObjectCustomFields } from "~/components/features/objects/ObjectCustomFields";

afterEach(() => {
  cleanup();
  currentDoc = null;
  publishing = false;
});

function customFieldsDoc(blobs: Record<number, string>): Y.Doc {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("objects");
  for (const [id, blob] of Object.entries(blobs)) {
    const m = new Y.Map<unknown>();
    m.set("_id", Number(id));
    m.set("extra_columns", blob);
    arr.push([m]);
  }
  settleCustomFields(doc);
  return doc;
}

const customObjectOf = (doc: Y.Doc, id: number) =>
  doc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("_id") === id)!;

/** The blob the snapshot writes for object `id`. */
const customBlobOf = (doc: Y.Doc, id: number) =>
  customFieldsBlob(customObjectOf(doc, id), () => customFieldBases(doc.getArray("objects")));

/** A collaborator's edit to one field, as their page binds it. */
function collaboratorTypes(doc: Y.Doc, id: number, key: string, value: string) {
  const text = customFieldsOf(customObjectOf(doc, id))!.get(key)!;
  doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, value);
  });
}

describe("customColumnOrder", () => {
  it("keeps one blob's order, not the alphabet", () => {
    expect(customColumnOrder([JSON.stringify({ zeta: "1", alpha: "2" })])).toEqual(["zeta", "alpha"]);
  });

  it("places a column only some rows filled where the other blobs put it", () => {
    const rows = [
      JSON.stringify({ a: "1", c: "3" }),
      JSON.stringify({ a: "1", b: "2", c: "3" }),
      JSON.stringify({ c: "3", d: "4" }),
    ];
    expect(customColumnOrder(rows)).toEqual(["a", "b", "c", "d"]);
  });

  it("puts columns no blob orders against each other in the order first seen", () => {
    expect(customColumnOrder([JSON.stringify({ zeta: "z" }), JSON.stringify({ alpha: "a" })])).toEqual(["zeta", "alpha"]);
  });

  it("leaves out instruction columns, which the framework drops", () => {
    expect(customColumnOrder([JSON.stringify({ "#note": "n", material: "wood", "# guide": "g" })])).toEqual(["material"]);
  });

  it("takes the order from the sheet's header, not from sparse rows", () => {
    const rows = [JSON.stringify({ a: "1", c: "3" }), JSON.stringify({ b: "2" })];
    expect(customColumnOrder(rows)).toEqual(["a", "c", "b"]);
    expect(customColumnOrder(rows, ["object_id", "title", "a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("puts a column the header does not name after the ones it does", () => {
    expect(customColumnOrder([JSON.stringify({ x: "1", b: "2" })], ["b"])).toEqual(["b", "x"]);
  });

  it("answers for blobs that contradict each other, and for none", () => {
    expect(customColumnOrder([JSON.stringify({ a: "", b: "" }), JSON.stringify({ b: "", a: "" })]).sort()).toEqual(["a", "b"]);
    expect(customColumnOrder([null, "", "not json"])).toEqual([]);
  });
});

describe("ObjectCustomFields", () => {
  it("lists every custom column of the sheet, in its order, even where this object has none", () => {
    currentDoc = customFieldsDoc({ 1: JSON.stringify({ zeta: "z", alpha: "a" }), 2: JSON.stringify({ material: "wood" }) });
    render(<ObjectCustomFields objectDbId={2} storedBlob={null} objectId="two" />);
    const labels = screen.getAllByRole("textbox").map((el) => (el as HTMLInputElement).labels?.[0]?.textContent);
    expect(labels.sort()).toEqual(["alpha", "material", "zeta"]);
    expect((screen.getByLabelText("material") as HTMLInputElement).value).toBe("wood");
    expect((screen.getByLabelText("zeta") as HTMLInputElement).value).toBe("");
    const sheet = screen.getAllByRole("textbox").map((el) => (el as HTMLInputElement).labels?.[0]?.textContent);
    expect(sheet.indexOf("zeta")).toBeLessThan(sheet.indexOf("alpha"));
  });

  it("writes an edit to the document as that one key, leaving the others", () => {
    currentDoc = customFieldsDoc({ 1: JSON.stringify({ zeta: "z", alpha: "a" }) });
    render(<ObjectCustomFields objectDbId={1} storedBlob={null} objectId="one" />);
    const input = screen.getByLabelText("alpha");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.blur(input);
    expect(JSON.parse(customBlobOf(currentDoc, 1))).toEqual({ zeta: "z", alpha: "changed" });
    expect(Object.keys(JSON.parse(customBlobOf(currentDoc, 1)))).toEqual(["zeta", "alpha"]);
  });

  it("shows the stored values read-only before the document connects, and nothing when there are none", () => {
    render(<ObjectCustomFields objectDbId={1} storedBlob={JSON.stringify({ material: "wood" })} objectId="one" />);
    const input = screen.getByLabelText("material") as HTMLInputElement;
    expect(input.value).toBe("wood");
    expect(input.disabled).toBe(true);
    cleanup();
    const { container } = render(<ObjectCustomFields objectDbId={1} storedBlob={null} objectId="one" />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps the same input while the author types and a collaborator edits that field", () => {
    currentDoc = customFieldsDoc({ 1: JSON.stringify({ material: "wood" }) });
    render(<ObjectCustomFields objectDbId={1} storedBlob={null} objectId="one" />);
    const input = screen.getByLabelText("material") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "my edit" } });
    act(() => collaboratorTypes(currentDoc!, 1, "material", "later"));
    expect(screen.getByLabelText("material")).toBe(input);
    expect(input.value).toBe("later");
  });

  it("shows a collaborator's value in a field the author is not editing", () => {
    currentDoc = customFieldsDoc({ 1: JSON.stringify({ material: "wood" }) });
    render(<ObjectCustomFields objectDbId={1} storedBlob={null} objectId="one" />);
    const input = screen.getByLabelText("material") as HTMLInputElement;
    act(() => collaboratorTypes(currentDoc!, 1, "material", "stone"));
    expect(screen.getByLabelText("material")).toBe(input);
    expect(input.value).toBe("stone");
  });

  it("orders its fields by the sheet header it is given", () => {
    currentDoc = customFieldsDoc({ 1: JSON.stringify({ a: "1", c: "3" }), 2: JSON.stringify({ b: "2" }) });
    render(<ObjectCustomFields objectDbId={1} storedBlob={null} objectId="one" sheetHeader={["object_id", "a", "b", "c"]} />);
    expect(screen.getAllByRole("textbox").map((el) => (el as HTMLInputElement).labels?.[0]?.textContent)).toEqual(["a", "b", "c"]);
  });

  it("shows no field for an instruction column", () => {
    currentDoc = customFieldsDoc({ 1: JSON.stringify({ "#note": "n", material: "wood" }) });
    render(<ObjectCustomFields objectDbId={1} storedBlob={null} objectId="one" />);
    expect(screen.queryByLabelText("#note")).toBeNull();
    expect(screen.getByLabelText("material")).toBeTruthy();
  });

  it("is read-only while a publish runs", () => {
    publishing = true;
    currentDoc = customFieldsDoc({ 1: JSON.stringify({ material: "wood" }) });
    render(<ObjectCustomFields objectDbId={1} storedBlob={null} objectId="one" />);
    expect((screen.getByLabelText("material") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("publish keeps the sheet's custom column order", () => {
  it("writes the file's order, not the alphabet, with an edited value in place", () => {
    const row = {
      object_id: "o1", title: "T", featured: null, creator: null, description: null, source_url: null, period: null,
      year: null, medium_genre: null, subjects: null, source: null, credit: null, thumbnail: null, alt_text: null,
      dimensions: null,
      extra_columns: JSON.stringify({ zeta: "z", alpha: "edited" }),
    } as ObjectRow;
    const file = "object_id,title,zeta,alpha\n,,,\no1,T,z,a\n";
    const [header, , data] = Papa.parse<string[]>(serializeObjectsCsv([row], file), { skipEmptyLines: true }).data;
    expect(header.filter((h) => h === "zeta" || h === "alpha")).toEqual(["zeta", "alpha"]);
    expect(data[header.indexOf("alpha")]).toBe("edited");
  });
});

describe("readObjectsSheetHeader", () => {
  const ok = (content: string) => async () => ({ status: "ok" as const, content });

  it("returns the header cells, stripped, with a byte-order mark and comment rows around it", async () => {
    expect(await readObjectsSheetHeader(ok("\uFEFFobject_id, title ,a,b\n,,,\n"))).toEqual(["object_id", "title", "a", "b"]);
  });

  it("names a repeated heading as the import does", async () => {
    expect(await readObjectsSheetHeader(ok("object_id,notes,notes,b\n"))).toEqual(["object_id", "notes", "notes_1", "b"]);
  });

  it("steps past a suffix another column already holds", async () => {
    expect(await readObjectsSheetHeader(ok("notes,notes,notes_1\n"))).toEqual(["notes", "notes_2", "notes_1"]);
  });

  it("falls back to objetos.csv when objects.csv is absent", async () => {
    const paths: string[] = [];
    const header = await readObjectsSheetHeader(async (path) => {
      paths.push(path);
      return path.endsWith("objetos.csv") ? { status: "ok", content: "id_objeto,x\n" } : { status: "absent" };
    });
    expect(header).toEqual(["id_objeto", "x"]);
    expect(paths).toHaveLength(2);
  });

  it("is null when the read fails or throws, or there is no sheet", async () => {
    const asked: string[] = [];
    expect(await readObjectsSheetHeader(async (path) => { asked.push(path); return { status: "error" }; })).toBeNull();
    expect(asked).toHaveLength(1);
    expect(await readObjectsSheetHeader(async () => { throw new Error("x"); })).toBeNull();
    expect(await readObjectsSheetHeader(async () => ({ status: "absent" }))).toBeNull();
  });
});

describe("readProjectObjectsHeader", () => {
  const project = { github_repo_full_name: "owner/site", installation_id: 7, head_sha: "abc123" };
  const env = { GITHUB_APP_ID: "app", GITHUB_PRIVATE_KEY: "key" };
  beforeEach(() => {
    resolveToken.mockReset();
    installationToken.mockReset();
    readAtRef.mockReset();
  });

  it("reads with the token resolved for the caller's role, not the member's own", async () => {
    resolveToken.mockResolvedValue("installation-token");
    readAtRef.mockResolvedValue({ status: "ok", content: "object_id,a,b\n" });
    expect(await readProjectObjectsHeader(env, project, "member-token", "collaborator")).toEqual(["object_id", "a", "b"]);
    expect(resolveToken).toHaveBeenCalledWith("app", "key", 7, "member-token", "collaborator");
    expect(readAtRef.mock.calls[0].slice(0, 5)).toEqual([
      "installation-token", "owner", "site", "telar-content/spreadsheets/objects.csv", "abc123",
    ]);
  });

  it("uses the installation token when the role's own token cannot read the file", async () => {
    resolveToken.mockResolvedValue("member-token");
    installationToken.mockResolvedValue("installation-token");
    readAtRef.mockReset();
    readAtRef.mockImplementation(async (token: string) =>
      token === "installation-token" ? { status: "ok", content: "object_id,a\n" } : { status: "absent" },
    );
    expect(await readProjectObjectsHeader(env, project, "member-token", "collaborator")).toEqual(["object_id", "a"]);
    expect(installationToken).toHaveBeenCalledWith("app", "key", 7);
    expect(readAtRef.mock.calls.map((c) => c[0])).toContain("installation-token");
  });

  it("is null when neither token reads the file", async () => {
    resolveToken.mockResolvedValue("member-token");
    installationToken.mockRejectedValue(new Error("no installation"));
    readAtRef.mockReset();
    readAtRef.mockResolvedValue({ status: "error" });
    expect(await readProjectObjectsHeader(env, project, "t", "collaborator")).toBeNull();
  });

  it("reads nothing without a recorded head, and is null when the token cannot be had", async () => {
    readAtRef.mockClear();
    expect(await readProjectObjectsHeader(env, { ...project, head_sha: null }, "t", "convenor")).toBeNull();
    expect(readAtRef).not.toHaveBeenCalled();
    resolveToken.mockRejectedValue(new Error("no installation"));
    expect(await readProjectObjectsHeader(env, project, "t", "collaborator")).toBeNull();
  });
});
