/**
 * The reduction to one file per page (`app/lib/one-language-pages.ts`)
 * against the framework's own `generate_pages`.
 *
 * The cross-check cases come from `fixtures/page-sisters/generate.py`, which
 * runs the framework's pages.py on the template's `about.md` and `acerca.md`
 * and on variants built from them (the command is in that file). For every
 * case the build completes, each address the framework wrote is a file kept,
 * holding the text of the file the framework wrote there, and no file kept
 * names a page by `localized_for`.
 *
 * @version v1.5.0-beta
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readBlock, reducePageFiles, type PageFile } from "~/lib/one-language-pages";
import { splitFrontmatterBlock } from "~/lib/page-frontmatter.server";

interface ReductionCase {
  name: string;
  lang: string;
  files: Record<string, string>;
  generated?: Record<string, string>;
  error?: string;
}

const reductionFixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/page-sisters/cases.json"), "utf8"),
) as { cases: ReductionCase[] };

const reductionCase = (name: string): ReductionCase => reductionFixture.cases.find((c) => c.name === name)!;

/** A file as the reduction reads it, split where the import and the publish split it. */
function reductionFileOf(name: string, content: string): PageFile {
  const split = splitFrontmatterBlock(content);
  return { name, frontmatter: split?.block ?? "", body: split?.body ?? content };
}

function reductionFilesOf(files: Record<string, string>): PageFile[] {
  return Object.entries(files).map(([name, content]) => reductionFileOf(name, content));
}

/** The served file's keys are inside a flow mapping or a merge, where no line holds them alone. */
const KEYS_NOT_ON_LINES = new Set([
  "flow sister",
  "flow key with no value before localized_for",
  "tagged merge as the first key",
]);

describe("reducePageFiles against generate_pages", () => {
  const built = reductionFixture.cases.filter((c) => c.generated && !KEYS_NOT_ON_LINES.has(c.name));
  it.each(built.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const files = reductionFilesOf(c.files);
    const { kept, removed } = reducePageFiles(files, c.lang);
    const byName = new Map(kept.map((k) => [k.file.name, k]));
    for (const [address, source] of Object.entries(c.generated!)) {
      const page = byName.get(address)!;
      expect(page.source.name).toBe(source);
      expect(page.body).toBe(files.find((f) => f.name === source)!.body);
    }
    for (const page of kept) expect(readBlock(page.frontmatter).kind).not.toBe("localized");
    for (const file of removed) expect(Object.keys(c.generated!)).not.toContain(file.name);
    expect(kept.length + removed.length).toBe(files.length);
  });

  it.each([...KEYS_NOT_ON_LINES])("%s: the served file stays beside its page, unchanged", (name) => {
    const files = reductionFilesOf(reductionCase(name).files);
    const { kept, removed } = reducePageFiles(files, "es");
    expect(removed).toEqual([]);
    expect(kept.map((k) => [k.file.name, k.source.name, k.frontmatter])).toEqual(
      files.map((f) => [f.name, f.name, f.frontmatter]),
    );
  });

  it.each(reductionFixture.cases.filter((c) => c.error).map((c) => [c.name, c] as const))(
    "%s: the build stops, and nothing is removed",
    (_name, c) => {
      expect(reducePageFiles(reductionFilesOf(c.files), c.lang).removed).toEqual([]);
    },
  );
});

describe("reducePageFiles on the template's About page", () => {
  const template = reductionCase("template, English site").files;
  const files = reductionFilesOf(template);

  it("keeps about.md as it is on an English site and removes acerca.md", () => {
    const { kept, removed } = reducePageFiles(files, "en");
    expect(kept).toEqual([{ file: files[0], source: files[0], frontmatter: files[0].frontmatter, body: files[0].body }]);
    expect(removed.map((f) => f.name)).toEqual(["acerca.md"]);
  });

  it("gives about.md the Spanish text on a Spanish site, without the two language lines", () => {
    const { kept, removed } = reducePageFiles(files, "es");
    expect(kept).toHaveLength(1);
    expect(kept[0].file.name).toBe("about.md");
    expect(kept[0].frontmatter).toBe("\ntitle: Acerca de Telar\n");
    expect(kept[0].body).toBe(files[1].body);
    expect(removed.map((f) => f.name)).toEqual(["acerca.md"]);
  });

  it("reads an empty site language as English", () => {
    expect(reducePageFiles(files, "").kept[0].source.name).toBe("about.md");
  });

  it("removes a file naming a page the site does not have, and one naming no language", () => {
    const orphan = reductionFilesOf(reductionCase("orphan").files);
    const noLanguage = reductionFilesOf(reductionCase("no language").files);
    expect(reducePageFiles(orphan, "es").removed.map((f) => f.name)).toEqual(["acerca.md"]);
    expect(reducePageFiles(noLanguage, "es").removed.map((f) => f.name)).toEqual(["acerca.md"]);
  });

  it("drops a language key's indented lines with it, and keeps the block's line endings", () => {
    const crlf = reductionFileOf("acerca.md", "---\r\ntitle: Acerca\r\nlanguage:\r\n  es\r\nlocalized_for: \"about.md\"\r\nsubtitle: x\r\n---\r\nTexto\r\n");
    const { kept } = reducePageFiles([files[0], crlf], "es");
    expect(kept[0].frontmatter).toBe("\r\ntitle: Acerca\r\nsubtitle: x\r\n");
  });

  it("takes the last of two files in the site's language, in name order", () => {
    const duplicates = reductionFilesOf(reductionCase("duplicates in the site language").files);
    const { kept, removed } = reducePageFiles([...duplicates].reverse(), "es");
    expect(kept.map((k) => k.source.name)).toEqual(["acerca.md"]);
    expect(removed.map((f) => f.name)).toEqual(["acerca-2.md", "acerca.md"]);
  });
});
