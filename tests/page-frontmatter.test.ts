/**
 * A page's front matter kept as its file has it: the boundary the import
 * stores and the publish writes back, and the one edit the publish makes to
 * it, the title.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  capturedFrontmatter,
  writePageFrontmatter,
} from "~/lib/page-frontmatter.server";
import type { FrontmatterWrite } from "~/lib/page-frontmatter.server";
import { parsePageMarkdown } from "~/lib/import.server";
import { serializePageMarkdown, UnwritablePageFrontmatterError } from "~/lib/publish.server";

/** The block a write produced; fails the test for any other answer. */
function blockOf(write: FrontmatterWrite): string {
  if (write.kind !== "block") throw new Error(`expected a block, got ${write.kind}`);
  return write.block;
}

/** The lines of `after` that differ from `before`, by index; both must have as many. */
function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [i]));
}

/** Import a file and publish it again with the title and body the import read. */
async function republished(file: string, slug: string): Promise<string> {
  const page = parsePageMarkdown(file, slug);
  return serializePageMarkdown(page.title, page.body, page.frontmatter, slug);
}

describe("the block a page stores", () => {
  it("is everything between the two markers: CRLF, comments, key order, a multi-line value", () => {
    const file =
      "---\r\ntitle: About\r\n# kept for the Spanish site\r\nlocalized_for: about\r\n" +
      "summary: >-\r\n  a folded\r\n  value\r\n\r\n---\r\n\r\nBody text.\r\n";
    expect(parsePageMarkdown(file, "about").frontmatter).toBe(
      "\r\ntitle: About\r\n# kept for the Spanish site\r\nlocalized_for: about\r\n" +
        "summary: >-\r\n  a folded\r\n  value\r\n\r\n",
    );
  });

  it('is "" for a file without front matter, and the newline between them for adjacent fences', () => {
    expect(parsePageMarkdown("Just a body.\n", "about").frontmatter).toBe("");
    // Written by hand: two fences with nothing between them.
    const adjacent = parsePageMarkdown("---\n---\n\nThe body.\n", "about");
    expect(adjacent.frontmatter).toBe("\n");
    expect(adjacent.body).toBe("The body.");
    expect(capturedFrontmatter("---\r\n---\r\nx")).toBe("\r\n");
  });

  it("does not end at a line that only starts with the marker", () => {
    expect(capturedFrontmatter("---\na: 1\n---b\nc: 2\n---\nbody")).toBe("\na: 1\n---b\nc: 2\n");
  });
});

describe("a page published with the title it was imported with", () => {
  // The body is trimmed on import and written after one blank line with one
  // final newline, so these files are in that shape; everything else is the
  // file's own.
  const cases: Array<[string, string]> = [
    ["LF", "---\ntitle: About\nlanguage: en\n---\n\nBody.\n"],
    ["CRLF", "---\r\ntitle: About\r\nlocalized_for: about\r\n---\r\n\r\nBody.\r\n"],
    ["a one-line CRLF block", "---\r\ntitle: About\r\n---\r\n\r\nBody.\r\n"],
    ["an empty block", "---\n---\n\nBody.\n"],
    ["a comment", "---\n# shown in the menu\ntitle: About # the English page\n---\n\nBody.\n"],
  ];
  for (const [label, file] of cases) {
    it(`is the same file, byte for byte: ${label}`, async () => {
      expect(await republished(file, "about")).toBe(file);
    });
  }
});

describe("writing the title into a kept block", () => {
  it("leaves a title the resolving schema would type, when the text is the same", () => {
    const block = "\ntitle: 2024\nlanguage: en\n";
    expect(blockOf(writePageFrontmatter(block, "2024"))).toBe(block);
  });

  it("leaves a block without a title when the title is what it already reads as", () => {
    const block = "\nlanguage: en\n";
    expect(blockOf(writePageFrontmatter(block, "about", "about"))).toBe(block);
  });

  it("replaces only the value of a plain title", () => {
    const block = "\nlanguage: en\ntitle: About\ntitle_key: about_title\n# end\n";
    const out = blockOf(writePageFrontmatter(block, "About us"));
    expect(changedLines(block, out)).toEqual([2]);
    expect(out.split("\n")[2]).toBe('title: "About us"');
  });

  it("replaces only the value of a quoted title, keeping a trailing comment", () => {
    const block = "\ntitle: 'About # us' # shown in the menu\nlocalized_for: about\n";
    const out = blockOf(writePageFrontmatter(block, "Acerca de"));
    expect(changedLines(block, out)).toEqual([1]);
    expect(out.split("\n")[1]).toBe('title: "Acerca de" # shown in the menu');
  });

  it("replaces only the value under a quoted key", () => {
    const block = '\n"title": About\nlanguage: en\n';
    const out = blockOf(writePageFrontmatter(block, "Acerca"));
    expect(out).toBe('\n"title": "Acerca"\nlanguage: en\n');
  });

  it("keeps CRLF on the edited line and every other", () => {
    const out = blockOf(writePageFrontmatter("\r\ntitle: About\r\nlanguage: en\r\n", "Acerca"));
    expect(out).toBe('\r\ntitle: "Acerca"\r\nlanguage: en\r\n');
  });

  it("writes the value through the shared escaper", () => {
    const out = blockOf(writePageFrontmatter("\ntitle: A\nx: 1\n", 'Say "hi": now'));
    expect(out).toBe('\ntitle: "Say \\"hi\\": now"\nx: 1\n');
  });

  it("puts a title line first in a block without one, after the opening fence's line", () => {
    const block = "\n# Spanish sister\nlocalized_for: about\nlanguage: es\n";
    const out = blockOf(writePageFrontmatter(block, "Acerca de", "acerca"));
    expect(out).toBe('\ntitle: "Acerca de"\n# Spanish sister\nlocalized_for: about\nlanguage: es\n');
  });

  it("puts a title into an empty block", async () => {
    expect(blockOf(writePageFrontmatter("\n", "About", "about-page"))).toBe('\ntitle: "About"\n');
    expect(await serializePageMarkdown("About", "Body.", "\n", "about-page")).toBe(
      '---\ntitle: "About"\n---\n\nBody.\n',
    );
  });

  it("leaves a nested title alone and puts the page's own title first", () => {
    const block = "\nseo:\n  title: Search title\nlanguage: en\n";
    const out = blockOf(writePageFrontmatter(block, "About", "about"));
    expect(out).toBe('\ntitle: "About"\nseo:\n  title: Search title\nlanguage: en\n');
  });

  it("replaces a block-scalar title's whole entry, and every other byte is kept", () => {
    const block =
      "\nlanguage: en\ntitle: |\n  About\n  us\n\n# a comment\nid: 9007199254740993\n" +
      "when: 2024-01-01\nz: 1\n10: ten\n2: two\n";
    const out = blockOf(writePageFrontmatter(block, "About us"));
    expect(out).toBe(
      '\nlanguage: en\ntitle: "About us"\n\n# a comment\nid: 9007199254740993\n' +
        "when: 2024-01-01\nz: 1\n10: ten\n2: two\n",
    );
  });

  it("replaces a multi-line plain title's whole entry, and every other byte is kept", () => {
    const block = "\r\ntitle: About\r\n  us here\r\ntitle_key: about_title\r\n";
    const out = blockOf(writePageFrontmatter(block, "About"));
    expect(out).toBe('\r\ntitle: "About"\r\ntitle_key: about_title\r\n');
  });

  it("is unwritable when both edits fail their re-parse", () => {
    // js-yaml reads a quoted scalar continued at column 0, so both the line
    // and the entry rule take the title for one line, and each edit leaves
    // `us"` behind.
    const block = '\ntitle: "About\nus"\nlanguage: en\n';
    expect(writePageFrontmatter(block, "Acerca")).toEqual({ kind: "unwritable" });
  });

  it("compares values that refer to themselves without failing", () => {
    const block = "\ntitle: Old\nx: &x\n  self: *x\n";
    const out = blockOf(writePageFrontmatter(block, "New"));
    expect(out).toBe('\ntitle: "New"\nx: &x\n  self: *x\n');
  });

  it("is unwritable when no edit keeps every other key, and the page is not written", async () => {
    // A flow mapping has no title line to edit, and prepending a second title
    // is not tried for a block that already holds one.
    const block = "\n{title: About, language: en}\n";
    expect(writePageFrontmatter(block, "Acerca")).toEqual({ kind: "unwritable" });
    await expect(serializePageMarkdown("Acerca", "Body", block, "acerca"))
      .rejects.toBeInstanceOf(UnwritablePageFrontmatterError);
  });

  it("is unwritable when the title's anchor is referred to elsewhere", () => {
    const block = "\ntitle: &t |\n  About\n  us\nalias: *t\n";
    expect(writePageFrontmatter(block, "About")).toEqual({ kind: "unwritable" });
  });

  it("writes the title alone for a block that does not parse", async () => {
    const block = "\ntitle: About\nbroken: [unclosed\nlanguage: en\n";
    expect(writePageFrontmatter(block, "Acerca")).toEqual({ kind: "title-alone" });
    expect(await serializePageMarkdown("Acerca", "Body", block, "acerca")).toBe(
      await serializePageMarkdown("Acerca", "Body"),
    );
  });

  it("writes the title alone for a block that parses to something other than a mapping", () => {
    expect(writePageFrontmatter("\n- a\n- b\n", "About")).toEqual({ kind: "title-alone" });
  });
});
