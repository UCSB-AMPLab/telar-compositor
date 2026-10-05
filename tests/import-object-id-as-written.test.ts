/**
 * An objects.csv id is read as written. The framework keeps `map` and `map  `
 * as two objects (`_clean_object_ids` writes a stripped id back only where it
 * removed an image extension), so the import stores two, a delete of one
 * leaves the other's row, and a removal is seen to land when that id alone is
 * gone. Each reading is also run through the framework's own conversion.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { removeObjectRecord } from "~/lib/csv-record-scan.server";
import { OBJECTS_CANONICAL_SCOPE, mapObjectsCsv, parseTelarCsv } from "~/lib/import.server";
import { siteObjectId } from "~/lib/object-id";
import { parseSheetObjectIds } from "~/lib/pending-object-ops.server";
import {
  FRAMEWORK_PYTHON,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  describeWithFramework,
} from "./helpers/framework-checkout";

const PADDED_SECOND = 'object_id,title\nmap,First\n"map  ",Second\n';
const PADDED_FIRST = 'object_id,title\n"map  ",First\nmap,Second\n';
const LEADING = 'object_id,title\n" map",First\nmap,Second\n';
const EXTENSION = 'object_id,title\n"map.jpg  ",First\nbell,Bell\n';

/** The ids and titles an import stores, in sheet order. */
function imported(csv: string): Array<[string, string | undefined]> {
  return mapObjectsCsv(parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE)).map((o) => [
    o.object_id,
    o.title ?? undefined,
  ]);
}

describe("the objects import reads an id as written", () => {
  it("stores `map` and `map  ` as two objects, in either order", () => {
    expect(imported(PADDED_SECOND)).toEqual([["map", "First"], ["map  ", "Second"]]);
    expect(imported(PADDED_FIRST)).toEqual([["map  ", "First"], ["map", "Second"]]);
    expect(imported(LEADING)).toEqual([[" map", "First"], ["map", "Second"]]);
  });

  it("keeps an id with an extension as written, the site id stripping it", () => {
    expect(imported(EXTENSION)).toEqual([["map.jpg  ", "First"], ["bell", "Bell"]]);
    expect(siteObjectId("map.jpg  ", null)).toBe("map");
  });

  it("drops a row whose id is only whitespace", () => {
    expect(imported('object_id,title\n"   ",Blank\nbell,Bell\n')).toEqual([["bell", "Bell"]]);
  });
});

describe("a delete targets one of two ids that differ only by whitespace", () => {
  it("removes the `map` row and leaves `map  `", () => {
    const removal = removeObjectRecord(PADDED_SECOND, "map");
    expect(removal).toEqual({ status: "removed", text: 'object_id,title\n"map  ",Second\n' });
  });

  it("removes the `map  ` row and leaves `map`", () => {
    const removal = removeObjectRecord(PADDED_SECOND, "map  ");
    expect(removal).toEqual({ status: "removed", text: "object_id,title\nmap,First\n" });
  });

  it("still removes every row of an id written the same way twice", () => {
    const removal = removeObjectRecord("object_id,title\nmap,First\nbell,Bell\nmap,Second\n", "map");
    expect(removal).toEqual({ status: "removed", text: "object_id,title\nbell,Bell\n" });
  });

  // An id stored before ids were read as written may be the stripped form of
  // the one row the file has. Reading that as absent would commit the object's
  // images away and leave its row.
  it("refuses, rather than calling absent, an id only the stripped form of a row matches", () => {
    expect(removeObjectRecord('object_id,title\n"map  ",Only\n', "map")).toEqual({ status: "unusable" });
  });

  it("sees the removal of `map` land while `map  ` stays", () => {
    expect(parseSheetObjectIds(PADDED_SECOND)).toEqual({ kind: "ids", ids: new Set(["map", "map  "]) });
    const removal = removeObjectRecord(PADDED_SECOND, "map");
    const committed = removal.status === "removed" ? removal.text : "";
    expect(parseSheetObjectIds(committed)).toEqual({ kind: "ids", ids: new Set(["map  "]) });
  });
});

/**
 * The object ids and titles `telar.core.csv_to_json` writes for objects.csv
 * with `process_objects` and the objects scope, run in the test instance's
 * interpreter from an empty directory, so no file of this repo is read as the
 * site's.
 */
function frameworkObjects(csv: string): Array<[string, string]> {
  const script = [
    "import sys, os, io, json, tempfile, contextlib",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "import telar.csv_utils as cu",
    "from telar.core import csv_to_json",
    "from telar.processors.objects import process_objects",
    "d = tempfile.mkdtemp()",
    "os.chdir(d)",
    "open('objects.csv', 'w', encoding='utf-8', newline='').write(sys.stdin.read())",
    "with contextlib.redirect_stdout(io.StringIO()):",
    "    ok = csv_to_json('objects.csv', 'objects.json', process_objects, canonical_fields=cu.OBJECT_FIELDS)",
    "rows = [r for r in json.load(open('objects.json', encoding='utf-8')) if not r.get('_metadata')] if ok else None",
    "print(json.dumps(None if rows is None else [[r['object_id'], r['title']] for r in rows]))",
  ].join("\n");
  const stdout = execFileSync(FRAMEWORK_PYTHON, ["-c", script], { input: csv, encoding: "utf-8" });
  return JSON.parse(stdout.trim().split("\n").at(-1) as string);
}

describeWithFramework("the objects import against the framework's csv_to_json and process_objects", () => {
  it.each([
    ["`map` then `map  `", PADDED_SECOND],
    ["`map  ` then `map`", PADDED_FIRST],
    ["` map` then `map`", LEADING],
  ])("holds %s apart as the build does", (_, csv) => {
    const framework = frameworkObjects(csv);
    expect(framework).toHaveLength(2);
    expect(imported(csv)).toEqual(framework);
  }, FRAMEWORK_TIMEOUT_MS);

  it("gives an id with an extension the site id the build gives it", () => {
    const framework = frameworkObjects(EXTENSION);
    expect(framework).toEqual([["map", "First"], ["bell", "Bell"]]);
    expect(imported(EXTENSION).map(([id, title]) => [siteObjectId(id, null), title])).toEqual(framework);
  }, FRAMEWORK_TIMEOUT_MS);
});
