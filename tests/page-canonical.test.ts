/**
 * The raw hash of a page's content: the value an accept of GitHub's version
 * is checked against.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { pageRawHash } from "~/lib/page-canonical";

describe("the raw hash", () => {
  const page = { title: "About", body: "Body", frontmatter: "\ntitle: About\n" };

  it("is stable for the same content", async () => {
    expect(await pageRawHash({ ...page })).toBe(await pageRawHash(page));
  });

  it("changes with each of the three fields", async () => {
    const base = await pageRawHash(page);
    expect(await pageRawHash({ ...page, title: "About us" })).not.toBe(base);
    expect(await pageRawHash({ ...page, body: "Body\n" })).not.toBe(base);
    expect(await pageRawHash({ ...page, frontmatter: "\ntitle: About\nlanguage: en\n" })).not.toBe(base);
  });

  it("tells a block never captured from a file with none", async () => {
    expect(await pageRawHash({ ...page, frontmatter: null })).not.toBe(await pageRawHash({ ...page, frontmatter: "" }));
  });

  it("does not depend on where one field ends and the next begins", async () => {
    expect(await pageRawHash({ title: "ab", body: "c", frontmatter: "" }))
      .not.toBe(await pageRawHash({ title: "a", body: "bc", frontmatter: "" }));
  });
});
