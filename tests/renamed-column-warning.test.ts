/**
 * The warning a publish page gives before a publish renames a repeated column.
 *
 * The import names a column by its position, so a header whose text repeats
 * keeps the first position under its name and gives each later one `name_N`.
 * Every serializer writes those names back as header text, so the published
 * file says `notes_1` where the author's sheet said `notes`. The warning is
 * raised only for a renamed column the publish will actually write: the keys
 * each serializer writes are computed by the serializer's own functions, so a
 * column that holds no values, or sits only on a step the story CSV leaves
 * out, is not named.
 *
 * Reads are asserted by path: each sheet is its own file, and a read of the
 * wrong one would warn about a file nobody is publishing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OBJECTS_CANONICAL_SCOPE, renamedColumns } from "~/lib/import.server";
import { getFileAtRef, type FileAtRef } from "~/lib/github.server";
import { renamedColumnWarningsAt } from "~/lib/renamed-columns.server";
import type {
  StepForValidation,
  ValidationItem,
  ValidationResult,
} from "~/lib/publish.server";

const OBJECTS = "telar-content/spreadsheets/objects.csv";
const GLOSSARY = "telar-content/spreadsheets/glossary.csv";
const WEAVERS = "telar-content/spreadsheets/weavers.csv";

const table = (csv: string): string[][] => csv.split("\n").map((line) => line.split(","));

type Sources = Parameters<typeof renamedColumnWarningsAt>[1];

/** No layers anywhere; a spy, so a test can say whether they were asked for. */
const noLayers = () => vi.fn(async () => [] as Awaited<ReturnType<Sources["loadLayers"]>>);

function sources(over: Partial<Sources> = {}): Sources {
  return { objects: [], glossary: [], stories: [], steps: [], loadLayers: noLayers(), ...over };
}

const ok = (content: string): FileAtRef => ({ status: "ok", content });

/** A read answering each path from `files`, and `absent` for any other. */
function readerOf(files: Record<string, FileAtRef>) {
  return vi.fn(async (path: string) => files[path] ?? ({ status: "absent" } as FileAtRef));
}

const PASSING: ValidationResult = { blockers: [], warnings: [] };

const STORY = { story_id: "weavers", title: "The Weavers", private: false, draft: false };

function step(over: Partial<StepForValidation>): StepForValidation {
  return {
    id: 1,
    step_number: 1,
    object_id: "loom",
    x: null,
    y: null,
    zoom: null,
    question: null,
    answer: null,
    story_id: "weavers",
    story_title: "The Weavers",
    kind: "media",
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("renamedColumns — which positions the import renames", () => {
  it("renames the second of two identical headers", () => {
    expect(renamedColumns(table("notes,notes\na,b"))).toEqual([
      { header: "notes", renamed: "notes_1", total: 2 },
    ]);
  });

  it("renames every later position of a triple, in file order", () => {
    expect(renamedColumns(table("notes,notes,notes\na,b,c"))).toEqual([
      { header: "notes", renamed: "notes_1", total: 3 },
      { header: "notes", renamed: "notes_2", total: 3 },
    ]);
  });

  it("renames nothing in a header that already says notes_1", () => {
    expect(renamedColumns(table("notes,notes_1\na,b"))).toEqual([]);
  });

  it("renames only the repeat when the file already has notes_1 between", () => {
    expect(renamedColumns(table("notes,notes_1,notes\na,b,c"))).toEqual([
      { header: "notes", renamed: "notes_2", total: 2 },
    ]);
  });

  it("names a repeated Spanish canonical header by its own text", () => {
    expect(renamedColumns(table("título,título\na,b"), OBJECTS_CANONICAL_SCOPE)).toEqual([
      { header: "título", renamed: "title_1", total: 2 },
    ]);
  });

  it("renames nothing for two spellings of one name, which collide instead", () => {
    expect(renamedColumns(table("title,Title\na,b"), OBJECTS_CANONICAL_SCOPE)).toEqual([]);
  });
});

describe("the warning, per sheet", () => {
  it("names a renamed column in objects.csv", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,title,notes,notes\nloom,Loom,a,b\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }] }),
      read,
    );
    expect(read.mock.calls.map(([path]) => path)).toEqual([OBJECTS]);
    expect(warnings).toEqual<ValidationItem[]>([
      {
        code: "renamed_duplicate_column",
        message: "renamed_duplicate_column",
        entityId: "objects.csv/notes",
        params: { file: "objects.csv", column: "notes", renamed: "notes_1" },
      },
    ]);
  });

  it("names a renamed column in glossary.csv", async () => {
    const read = readerOf({ [GLOSSARY]: ok("term_id,title,definition,note,note\nwarp,Warp,Threads,a,b\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ glossary: [{ term_id: "warp", extra_columns: '{"note":"a","note_1":"b"}' }] }),
      read,
    );
    expect(read.mock.calls.map(([path]) => path)).toEqual([GLOSSARY]);
    expect(warnings).toEqual<ValidationItem[]>([
      {
        code: "renamed_duplicate_column",
        message: "renamed_duplicate_column",
        entityId: "glossary.csv/note",
        params: { file: "glossary.csv", column: "note", renamed: "note_1" },
      },
    ]);
  });

  it("reads objetos.csv and glosario.csv of a site holding only those, and names them", async () => {
    const read = readerOf({
      "telar-content/spreadsheets/objetos.csv": ok("object_id,title,notes,notes\nloom,Loom,a,b\n"),
      "telar-content/spreadsheets/glosario.csv": ok("term_id,title,definition,note,note\nwarp,Warp,Threads,a,b\n"),
    });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({
        objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }],
        glossary: [{ term_id: "warp", extra_columns: '{"note":"a","note_1":"b"}' }],
      }),
      read,
    );
    expect(warnings.map((w) => w.params)).toEqual([
      { file: "objetos.csv", column: "notes", renamed: "notes_1" },
      { file: "glosario.csv", column: "note", renamed: "note_1" },
    ]);
  });

  it("does not read objetos.csv where objects.csv is there", async () => {
    const read = readerOf({
      [OBJECTS]: ok("object_id,title,notes,notes\nloom,Loom,a,b\n"),
      "telar-content/spreadsheets/objetos.csv": ok("object_id,title,notes,notes\nloom,Loom,a,b\n"),
    });
    await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }] }),
      read,
    );
    expect(read.mock.calls.map((c) => c[0])).not.toContain("telar-content/spreadsheets/objetos.csv");
  });

  it("names a renamed column in a story CSV, read at the story's own path", async () => {
    const read = readerOf({ [WEAVERS]: ok("step,object,notes,notes\n1,loom,a,b\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({
        stories: [STORY],
        steps: [step({ extra_columns: '{"notes":"a","notes_1":"b"}' })],
      }),
      read,
    );
    expect(read.mock.calls.map(([path]) => path)).toEqual([WEAVERS]);
    expect(warnings).toEqual<ValidationItem[]>([
      {
        code: "renamed_duplicate_column",
        message: "renamed_duplicate_column",
        entityId: "weavers.csv/notes",
        params: { file: "weavers.csv", column: "notes", renamed: "notes_1" },
      },
    ]);
  });

  it("gives a triple one warning, with the count and both new names", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,notes,notes,notes\nloom,a,b,c\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({
        objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b","notes_2":"c"}' }],
      }),
      read,
    );
    expect(warnings).toEqual<ValidationItem[]>([
      {
        code: "renamed_duplicate_columns",
        message: "renamed_duplicate_columns",
        entityId: "objects.csv/notes",
        params: { file: "objects.csv", column: "notes", total: 3, renamed: '"notes_1", "notes_2"' },
      },
    ]);
  });
});

describe("three columns of which one new name is written", () => {
  it("counts every column sharing the header and lists only the name written", async () => {
    // `notes_1` holds no value, so only `notes_2` is written; the sentence
    // still counts the three columns the author's sheet has.
    const read = readerOf({ [OBJECTS]: ok("object_id,notes,notes,notes\nloom,a,,c\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_2":"c"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.code, w.params])).toEqual([
      ["renamed_duplicate_columns", { file: "objects.csv", column: "notes", total: 3, renamed: '"notes_2"' }],
    ]);
  });
});

describe("a canonical header beside the same header with spaces round it", () => {
  // The spaced column is a collision candidate and is dropped for being
  // empty; it still counts toward the columns the file has.
  it("counts a dropped column among those sharing the header", () => {
    expect(renamedColumns(table("object_id,title,title, title , title \no1,A,B,,C"), OBJECTS_CANONICAL_SCOPE)).toEqual([
      { header: "title", renamed: "title_1", total: 4 },
      { header: "title", renamed: "title_2", total: 4 },
    ]);
  });

  it("names the new names in the warning, with the count of every such column", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,title,title, title , title \nloom,A,B,,C\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "A", extra_columns: '{"title_1":"B","title_2":"C"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.code, w.params])).toEqual([
      ["renamed_duplicate_columns", { file: "objects.csv", column: "title", total: 4, renamed: '"title_1", "title_2"' }],
    ]);
  });

  it("renames a spaced header repeated with the same spaces", () => {
    expect(renamedColumns(table("object_id, title , title \no1,A,B"), OBJECTS_CANONICAL_SCOPE)).toEqual([
      { header: "title", renamed: "title_1", total: 2 },
    ]);
  });

  it("gives the stripped reading's name to the second of title and a spaced title", () => {
    const csv = table("object_id,title, title \no1,,Kept");
    expect(renamedColumns(csv, OBJECTS_CANONICAL_SCOPE)).toEqual([]);
    expect(renamedColumns(csv, OBJECTS_CANONICAL_SCOPE, "stripped")).toEqual([
      { header: "title", renamed: "title_1", total: 2 },
    ]);
  });

  it("names a lone title_1 the stripped reading stored, under title", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,title, title \nloom,,Kept\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: null, extra_columns: '{"title_1":"Kept"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.code, w.params])).toEqual([
      ["renamed_duplicate_column", { file: "objects.csv", column: "title", renamed: "title_1" }],
    ]);
  });

  // The stripped reading names ` title ` title_1 and the second título
  // title_2; the import's own reading names that título title_1. D1 writing
  // both is accounted for only by the stripped reading, so both keys are named
  // under it.
  it("names each written key once, under the reading that accounts for them all", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,title, title ,título,título\nloom,,B,,C\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: null, extra_columns: '{"title_1":"B","title_2":"C"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.code, w.params])).toEqual([
      ["renamed_duplicate_column", { file: "objects.csv", column: "title", renamed: "title_1" }],
      ["renamed_duplicate_column", { file: "objects.csv", column: "título", renamed: "title_2" }],
    ]);
  });

  // With title_1 alone written, both readings account for one key. The
  // import's own reading renames nothing else under título, so its group is
  // whole and it names the key.
  it("names a key both readings account for equally under the import's reading when its group is whole", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,title, title ,título,título\nloom,,B,,C\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "B", extra_columns: '{"title_1":"C"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.code, w.params])).toEqual([
      ["renamed_duplicate_column", { file: "objects.csv", column: "título", renamed: "title_1" }],
    ]);
  });

  // Both readings account for title_1 alone. The import's own reading gives
  // título title_1 and title_2, and D1 writes only the first, so that group
  // was not stored by it: the key is named under the stripped reading.
  it("names a key both readings account for equally under the stripped reading when the other group is partly unwritten", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,title, title ,título,título,título\nloom,,B,,C,D\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: null, extra_columns: '{"title_1":"B"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.code, w.params])).toEqual([
      ["renamed_duplicate_column", { file: "objects.csv", column: "title", renamed: "title_1" }],
    ]);
  });

  it("names a title_1 stored when the file was read with its cells stripped", async () => {
    const read = readerOf({ [OBJECTS]: ok("object_id,title,title, title \nloom,,second,Kept\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: null, extra_columns: '{"title_1":"second","title_2":"Kept"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.code, w.params])).toEqual([
      ["renamed_duplicate_columns", { file: "objects.csv", column: "title", total: 3, renamed: '"title_1", "title_2"' }],
    ]);
  });
});

describe("what is not warned about", () => {
  it("reads a file whose own header says notes_1, and names nothing", async () => {
    // The author's own `notes_1` passes the suffix gate, so the file is read;
    // its header is not renamed, so there is nothing to say.
    const read = readerOf({ [OBJECTS]: ok("object_id,notes,notes_1\nloom,a,b\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }] }),
      read,
    );
    expect(read.mock.calls.map(([path]) => path)).toEqual([OBJECTS]);
    expect(warnings).toEqual([]);
  });

  it("names only the renamed column the publish writes", async () => {
    // `notes_1` holds no value in D1, so no column is written under it; the
    // file is read because `other_1` is written.
    const read = readerOf({ [OBJECTS]: ok("object_id,notes,notes,other,other\nloom,a,,c,d\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","other":"c","other_1":"d"}' }] }),
      read,
    );
    expect(warnings.map((w) => w.params?.renamed)).toEqual(["other_1"]);
  });

  it("makes no read when no written key ends in a suffix", async () => {
    const read = readerOf({});
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a"}' }] }),
      read,
    );
    expect(read).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("leaves out a step the story CSV drops, whose only cell is an instruction column", async () => {
    // The serializer drops a fully empty step, and an instruction column's cell
    // does not make a step non-empty, so `#note_1` is never written.
    // The story passes the suffix gate on all its steps, so its layers are
    // asked for, once; they hold no panel, so the step is dropped.
    const read = readerOf({ [WEAVERS]: ok("step,#note,#note\n1,,text\n") });
    const input = sources({
      stories: [STORY],
      steps: [step({ object_id: null, extra_columns: '{"#note_1":"text"}' })],
    });
    const warnings = await renamedColumnWarningsAt(PASSING, input, read);
    expect(input.loadLayers).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("keeps the same step when one of its layers is a panel", async () => {
    const read = readerOf({ [WEAVERS]: ok("step,#note,#note\n1,,text\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({
        stories: [STORY],
        steps: [step({ id: 7, object_id: null, extra_columns: '{"#note_1":"text"}' })],
        loadLayers: vi.fn(async () => [
          { step_id: 8, title: "Another step's panel", content: "" },
          { step_id: 7, title: "The loom", content: "" },
        ]),
      }),
      read,
    );
    expect(warnings.map((w) => w.params?.renamed)).toEqual(["#note_1"]);
  });

  it("judges a step by its own layers, not another step's", async () => {
    const read = readerOf({ [WEAVERS]: ok("step,#note,#note\n1,,text\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({
        stories: [STORY],
        steps: [step({ id: 7, object_id: null, extra_columns: '{"#note_1":"text"}' })],
        loadLayers: vi.fn(async () => [{ step_id: 8, title: "Another step's panel", content: "" }]),
      }),
      read,
    );
    expect(read).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("keeps a section step, which the serializer never drops", async () => {
    const read = readerOf({ [WEAVERS]: ok("step,#note,#note\n1,,text\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({
        stories: [STORY],
        steps: [step({ object_id: null, kind: "section", extra_columns: '{"#note_1":"text"}' })],
      }),
      read,
    );
    expect(warnings.map((w) => w.params?.renamed)).toEqual(["#note_1"]);
  });

  it("asks for no layers when no story's steps carry a suffixed key", async () => {
    // Objects pass the gate; the story does not, even counting the steps the
    // serializer would drop, so neither its layers nor its sheet are read.
    const read = readerOf({ [OBJECTS]: ok("object_id,notes,notes\nloom,a,b\n") });
    const input = sources({
      objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }],
      stories: [STORY],
      steps: [step({ extra_columns: '{"notes":"a"}' })],
    });
    const warnings = await renamedColumnWarningsAt(PASSING, input, read);
    expect(input.loadLayers).not.toHaveBeenCalled();
    expect(read.mock.calls.map(([path]) => path)).toEqual([OBJECTS]);
    expect(warnings.map((w) => w.params?.file)).toEqual(["objects.csv"]);
  });

  it("asks for the layers once, however many stories pass the gate", async () => {
    const OTHER = { ...STORY, story_id: "dyers", title: "The Dyers" };
    const input = sources({
      stories: [STORY, OTHER],
      steps: [
        step({ id: 1, extra_columns: '{"notes_1":"a"}' }),
        step({ id: 2, story_id: "dyers", extra_columns: '{"notes_1":"b"}' }),
      ],
    });
    await renamedColumnWarningsAt(PASSING, input, readerOf({}));
    expect(input.loadLayers).toHaveBeenCalledTimes(1);
  });

  it("makes no read while the stale-head blocker stands", async () => {
    const input = sources({
      objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"notes_1":"b"}' }],
      stories: [STORY],
      steps: [step({ extra_columns: '{"notes_1":"b"}' })],
    });
    const read = readerOf({ [OBJECTS]: ok("object_id,notes,notes\nloom,a,b\n") });
    const warnings = await renamedColumnWarningsAt(
      { blockers: [{ code: "stale_head", message: "stale_head" }], warnings: [] },
      input,
      read,
    );
    expect(read).not.toHaveBeenCalled();
    expect(input.loadLayers).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});

describe("a read that cannot be relied on", () => {
  const OBJECT = { object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' };

  it("gives no warning for a file that is absent", async () => {
    const warnings = await renamedColumnWarningsAt(PASSING, sources({ objects: [OBJECT] }), readerOf({}));
    expect(warnings).toEqual([]);
  });

  it("gives no warning for a read that fails, and says so in the log", async () => {
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [OBJECT] }),
      readerOf({ [OBJECTS]: { status: "error" } }),
    );
    expect(warnings).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(OBJECTS));
  });

  it("gives no warning for a read that throws", async () => {
    const read = vi.fn(async () => {
      throw new Error("network");
    });
    const warnings = await renamedColumnWarningsAt(PASSING, sources({ objects: [OBJECT] }), read);
    expect(warnings).toEqual([]);
  });

  it("gives the story no warning when its layers cannot be read, and still names the objects", async () => {
    const read = readerOf({
      [OBJECTS]: ok("object_id,notes,notes\nloom,a,b\n"),
      [WEAVERS]: ok("step,object,notes,notes\n1,loom,a,b\n"),
    });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({
        objects: [OBJECT],
        stories: [STORY],
        steps: [step({ extra_columns: '{"notes":"a","notes_1":"b"}' })],
        loadLayers: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      }),
      read,
    );
    expect(warnings.map((w) => w.entityId)).toEqual(["objects.csv/notes"]);
    expect(read.mock.calls.map(([path]) => path)).not.toContain(WEAVERS);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("layers"));
  });

  it("gives no warning for a truncated body, through the strict read itself", async () => {
    // The Contents API answers a size the body does not reach; a strict read
    // is an error rather than the half of the file it carries.
    const body = "object_id,notes,notes\nloom,a,b\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            type: "file",
            encoding: "base64",
            size: body.length + 40,
            content: Buffer.from(body).toString("base64"),
          }),
          { status: 200 },
        ),
      ),
    );
    const read = (path: string) => getFileAtRef("t", "o", "r", path, "sha", { strict: true });
    const warnings = await renamedColumnWarningsAt(PASSING, sources({ objects: [OBJECT] }), read);
    expect(warnings).toEqual([]);
  });

  it("reads past a leading byte-order mark", async () => {
    const read = readerOf({ [OBJECTS]: ok("\uFEFFnotes,notes,object_id\na,b,loom\n") });
    const warnings = await renamedColumnWarningsAt(PASSING, sources({ objects: [OBJECT] }), read);
    expect(warnings.map((w) => [w.params?.column, w.params?.renamed])).toEqual([["notes", "notes_1"]]);
  });
});

describe("the scope each sheet is read under", () => {
  it("reads a story CSV under the story scope, where paso is step", async () => {
    const read = readerOf({ [WEAVERS]: ok("paso,object,paso\n1,loom,2\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ stories: [STORY], steps: [step({ extra_columns: '{"step_1":"2"}' })] }),
      read,
    );
    expect(warnings.map((w) => [w.params?.column, w.params?.renamed])).toEqual([["paso", "step_1"]]);
  });

  it("reads objects.csv under the objects scope, where paso is an author's own column", async () => {
    // Unscoped, `paso` would fold to `step` and its repeat to `step_1`, a
    // name the objects serializer never writes.
    const read = readerOf({ [OBJECTS]: ok("object_id,paso,paso\nloom,1,2\n") });
    const warnings = await renamedColumnWarningsAt(
      PASSING,
      sources({ objects: [{ object_id: "loom", title: "Loom", extra_columns: '{"paso":"1","paso_1":"2"}' }] }),
      read,
    );
    expect(warnings.map((w) => [w.params?.column, w.params?.renamed])).toEqual([["paso", "paso_1"]]);
  });
});
