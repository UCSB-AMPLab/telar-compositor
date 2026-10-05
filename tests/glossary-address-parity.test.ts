/**
 * Which glossary terms the preview links, and where, against the framework's
 * `_csv_page_rows` and `glossary_term_url` (scripts/telar/glossary_pages.py,
 * glossary.py): of ids published at one address the first keeps it and the
 * others are not terms, so a reference to one is an unknown term. Addresses
 * are compared as written, with no casefolding or normalisation, so ids whose
 * slugs differ each publish, and an id with an empty slug is at `/glossary//`.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { glossaryTermsFromDoc, glossaryTermUrl, resolveGlossaryLinks } from "~/lib/glossary-links";
import { opensKeptTerm, sharedGlossaryAddresses } from "~/lib/glossary-addresses";
import {
  FRAMEWORK_PYTHON,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  describeWithFramework,
} from "./helpers/framework-checkout";

type Row = [id: string, title: string];

/** The framework checkout, a Telar site with the template's glossary page. */
const SITE = join(FRAMEWORK_SCRIPTS_DIR, "..");

function docOf(rows: Row[]): Y.Doc {
  const ydoc = new Y.Doc();
  const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
  glossary.push(
    rows.map(([id, title]) => {
      const m = new Y.Map<unknown>();
      m.set("term_id", id);
      m.set("title", title);
      return m;
    }),
  );
  return ydoc;
}

const CASES: Array<[string, Row[]]> = [
  ["ids differing only in case", [["IIIF", "First"], ["iiif", "Second"]]],
  ["the later spelling first", [["iiif", "First"], ["IIIF", "Second"]]],
  ["ids differing only in punctuation", [["Colonial Period", "A"], ["colonial-period", "B"], ["colonial_period", "C"]]],
  ["the same id twice", [["loom", "A"], ["loom", "B"]]],
  ["a dropped id does not hold an address a later one could use", [["x", ""], ["X", "B"]]],
  ["ids that share nothing", [["a", "A"], ["b", "B"], ["Café", "C"]]],
  // Slugs that differ publish apart, though a case- and normalization-
  // insensitive disk would write them to one file.
  ["a sharp s and its folding", [["Straße", "A"], ["strasse", "B"]]],
  ["an accent composed and decomposed", [["\u00e9t\u00e9", "A"], ["e\u0301te\u0301", "B"]]],
  ["an id with an empty slug", [["!!!", "A"], ["b", "B"]]],
];

describe("glossaryTermsFromDoc, the first term at each address", () => {
  it("keeps the first of ids published at one address", () => {
    expect([...glossaryTermsFromDoc(docOf([["IIIF", "First"], ["iiif", "Second"]]))]).toEqual([["IIIF", "First"]]);
  });

  it("reads a reference to the dropped id as the term that kept the address", () => {
    const terms = glossaryTermsFromDoc(docOf([["iiif", "First"], ["IIIF", "Second"]]));
    expect(resolveGlossaryLinks("[[IIIF]]", terms, "")).toContain('data-term-id="iiif"');
  });
});

function frameworkKept(rows: Row[]): { kept: string[]; urls: Record<string, string> } {
  const header = "term_id,title,definition\n";
  const csv = header + rows.map(([id, title]) => `"${id}","${title}",d`).join("\n") + "\n";
  const script = [
    "import sys, os, json, io, tempfile, contextlib",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "from telar.glossary_pages import _csv_page_rows",
    "from telar.glossary import glossary_term_url",
    "path = os.path.join(tempfile.mkdtemp(), 'glossary.csv')",
    "open(path, 'w', encoding='utf-8', newline='').write(sys.stdin.read())",
    "with contextlib.redirect_stdout(io.StringIO()):",
    "    kept = [t for t, _title, _row in _csv_page_rows(path)]",
    "print(json.dumps({'kept': kept, 'urls': {t: glossary_term_url(t, '/base') for t in kept}}))",
  ].join("\n");
  const stdout = execFileSync(FRAMEWORK_PYTHON, ["-c", script], { input: csv, encoding: "utf-8", cwd: SITE });
  return JSON.parse(stdout.trim().split("\n").at(-1) as string);
}

describeWithFramework("the preview's glossary terms against the framework's pages", () => {
  it.each(CASES)("keeps the terms the build publishes: %s", (_, rows) => {
    const framework = frameworkKept(rows);
    const preview = glossaryTermsFromDoc(docOf(rows));
    expect([...preview.keys()]).toEqual(framework.kept);
    for (const id of preview.keys()) expect(glossaryTermUrl(id, "/base")).toBe(framework.urls[id]);
  }, FRAMEWORK_TIMEOUT_MS);

  it.each(CASES)("reports as shared the addresses the build reports: %s", (_, rows) => {
    const kept = frameworkKept(rows).kept;
    const shared = sharedGlossaryAddresses(rows.map(([term_id, title]) => ({ term_id, title })));
    const dropped = shared.flatMap((address) => address.dropped);
    // A dropped id comes after the one that keeps the address, which may be
    // the same id written again: the later rows go first.
    const published: string[] = [];
    for (const [id, title] of [...rows].reverse()) {
      if (!id || !title) continue;
      const at = dropped.indexOf(id);
      if (at === -1) published.unshift(id);
      else dropped.splice(at, 1);
    }
    expect(published).toEqual(kept);
  }, FRAMEWORK_TIMEOUT_MS);
});

/** What the framework's `process_glossary_links` makes of `[[ref]]` against the pages `rows` publish. */
function frameworkReference(rows: Row[], ref: string): "link" | "missing" {
  const csv = "term_id,title,definition\n" + rows.map(([id, title]) => `"${id}","${title}",d`).join("\n") + "\n";
  const script = [
    "import sys, os, io, tempfile, contextlib, json",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "import telar.glossary_pages as gp",
    "from telar.glossary import glossary_link_map, process_glossary_links",
    "path = os.path.join(tempfile.mkdtemp(), 'glossary.csv')",
    "open(path, 'w', encoding='utf-8', newline='').write(sys.stdin.read())",
    "with contextlib.redirect_stdout(io.StringIO()):",
    "    link_map = glossary_link_map(gp._csv_pages(gp._csv_page_rows(path)))",
    `    out = process_glossary_links(${JSON.stringify(`[[${ref}]]`)}, link_map, [], 1, 'x', base_url='')`,
    "import re",
    "m = re.search(r'data-term-id=\"([^\"]*)\"', out) if 'glossary-inline-link' in out else None",
    "print(json.dumps(m.group(1) if m else 'missing'))",
  ].join("\n");
  const stdout = execFileSync(FRAMEWORK_PYTHON, ["-c", script], { input: csv, encoding: "utf-8", cwd: SITE });
  return JSON.parse(stdout.trim().split("\n").at(-1) as string);
}

describeWithFramework("a reference to the id the site does not publish", () => {
  it.each([
    ["differing only in case", [["IIIF", "A"], ["iiif", "B"]] as Row[], "iiif", "IIIF"],
    ["differing in punctuation", [["colonial-period", "A"], ["Colonial Period", "B"]] as Row[], "Colonial Period", "missing"],
  ])("%s resolves as the preview and the notice's wording say", (_, rows, dropped, expected) => {
    expect(frameworkReference(rows, dropped)).toBe(expected);
    const preview = resolveGlossaryLinks(`[[${dropped}]]`, glossaryTermsFromDoc(docOf(rows)), "");
    const linked = preview.includes("glossary-inline-link") ? /data-term-id="([^"]*)"/.exec(preview)?.[1] : undefined;
    expect(linked ?? "missing").toBe(expected);
    expect(opensKeptTerm(rows[0][0], dropped)).toBe(expected !== "missing");
  }, FRAMEWORK_TIMEOUT_MS);
});

/** What the framework's `process_glossary_links` writes for `text` against the pages `rows` publish. */
function frameworkLinked(rows: Row[], text: string): string {
  const csv = "term_id,title,definition\n" + rows.map(([id, title]) => `"${id}","${title}",d`).join("\n") + "\n";
  const script = [
    "import sys, os, io, tempfile, contextlib, json",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "import telar.glossary_pages as gp",
    "from telar.glossary import glossary_link_map, process_glossary_links",
    "path = os.path.join(tempfile.mkdtemp(), 'glossary.csv')",
    "open(path, 'w', encoding='utf-8', newline='').write(sys.stdin.read())",
    "with contextlib.redirect_stdout(io.StringIO()):",
    "    link_map = glossary_link_map(gp._csv_pages(gp._csv_page_rows(path)))",
    `    out = process_glossary_links(${JSON.stringify(text)}, link_map, None, base_url='')`,
    "print(json.dumps(out))",
  ].join("\n");
  const stdout = execFileSync(FRAMEWORK_PYTHON, ["-c", script], { input: csv, encoding: "utf-8", cwd: SITE });
  return JSON.parse(stdout.trim().split("\n").at(-1) as string);
}

describeWithFramework("an id with an empty slug", () => {
  it.each([
    ["with another term", [["!!!", "Symbols"], ["b", "B"]] as Row[], "See [[!!!]] and [[b]]."],
    ["the only term", [["\u2014", "Dash"]] as Row[], "See [[\u2014]] and [[\u2014|the dash]]."],
  ])("%s: is a term at /glossary//, and a reference is written as the build writes it", (_, rows, text) => {
    const terms = glossaryTermsFromDoc(docOf(rows));
    expect(resolveGlossaryLinks(text, terms, "")).toBe(frameworkLinked(rows, text));
    expect(glossaryTermUrl(rows[0][0], "")).toBe("/glossary//");
  }, FRAMEWORK_TIMEOUT_MS);
});
