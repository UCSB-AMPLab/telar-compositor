/**
 * Framework-owned frontmatter reaches the built-in pages of an existing site
 *.
 *
 * The three built-in pages are author-editable below their frontmatter, so an
 * upgrade never delivers them whole, and the one transform that touches them
 * re-emits the site's block verbatim. So a key the framework adds to their
 * frontmatter reached no existing site: `title_key` made the browser-tab
 * title follow the site's language, and every site created before it kept an
 * English tab title on a translated site.
 *
 * What these cases hold the merge to is the author's file: every byte it does
 * not add is the author's and stays, a present key is never rewritten, and a
 * block the merge cannot read — or a result it cannot read back — leaves the
 * file alone. The release copies below are the frontmatter the framework
 * ships on these pages, verbatim from the telar repository.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  BUILT_IN_PAGES,
  applyBuiltInPageFrontmatter,
  mergeFrameworkFrontmatter,
  type TargetPage,
} from "~/lib/framework-page-frontmatter.server";
import { indexMdForPublish } from "~/lib/publish.server";

const RELEASE: Record<string, string> = {
  "index.md": "---\nlayout: index\ntitle: Home\ntitle_key: navigation.home\n---\n\nbody\n",
  "pages/glossary.md":
    "---\nlayout: glossary-index\ntitle: Glossary\ntitle_key: navigation.glossary\npermalink: /glossary/\n---\n\nbody\n",
  "pages/objects.md":
    "---\nlayout: objects-index\ntitle: Objects in the Stories\ntitle_key: navigation.objects\npermalink: /objects/\n---\n\nbody\n",
};

const AUTHOR_BODY =
  "\n{% assign lang = site.data.languages[site.telar_language] %}\n\nMi propio texto sobre el glosario.\n  Con sangría.\n";

function glossary(frontmatter: string, body = AUTHOR_BODY) {
  return `---\n${frontmatter}---\n${body}`;
}

const merge = (site: string, path = "pages/glossary.md") =>
  mergeFrameworkFrontmatter(path, site, RELEASE[path]);

describe("a built-in page from before title_key", () => {
  it("gains title_key, and nothing else about the file changes", () => {
    const site = glossary("layout: glossary-index\ntitle: Glossary\npermalink: /glossary/\n");

    expect(merge(site)).toBe(
      glossary(
        "layout: glossary-index\ntitle: Glossary\npermalink: /glossary/\ntitle_key: navigation.glossary\n",
      ),
    );
  });

  it("keeps an author's body byte for byte, indentation and blank lines included", () => {
    const site = glossary("layout: glossary-index\ntitle: Glossary\npermalink: /glossary/\n");
    const merged = merge(site) as string;

    expect(merged.slice(merged.indexOf("\n---\n") + 5)).toBe(AUTHOR_BODY);
  });

  it("keeps CRLF line endings, and writes the new line in them", () => {
    const site = glossary("layout: glossary-index\ntitle: Glossary\npermalink: /glossary/\n").replace(
      /\n/g,
      "\r\n",
    );
    const merged = merge(site) as string;

    expect(merged).toContain("title_key: navigation.glossary\r\n---\r\n");
    expect(merged.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("gains every framework-owned key it lacks", () => {
    expect(merge(glossary("title: Glossary\n"))).toBe(
      glossary(
        "title: Glossary\nlayout: glossary-index\ntitle_key: navigation.glossary\npermalink: /glossary/\n",
      ),
    );
  });

  it("works for all three pages", () => {
    for (const path of Object.keys(BUILT_IN_PAGES)) {
      const titleKeyLine = RELEASE[path].match(/^title_key: .*\n/m)![0];
      const withoutKey = RELEASE[path].replace(titleKeyLine, "");
      // The new line goes last in the block, directly above the closing fence.
      const expected = withoutKey.replace(/---\n\nbody\n$/, `${titleKeyLine}---\n\nbody\n`);
      expect(mergeFrameworkFrontmatter(path, withoutKey, RELEASE[path])).toBe(expected);
    }
  });
});

describe("a page whose author retitled it", () => {
  it("does not gain title_key, which would replace the author's title in the browser tab", () => {
    // The layout lets a resolved title_key win over title.
    const site = glossary("layout: glossary-index\ntitle: Glosario del Nuevo Reino\npermalink: /glossary/\n");
    expect(merge(site)).toBeNull();
  });

  it("still gains the keys that do not touch the title", () => {
    const site = glossary("title: Glosario del Nuevo Reino\n");
    expect(merge(site)).toBe(
      glossary("title: Glosario del Nuevo Reino\nlayout: glossary-index\npermalink: /glossary/\n"),
    );
  });

  it("gains title_key when the title is the framework's own, quoted or not", () => {
    const site = glossary('layout: glossary-index\ntitle: "Glossary"\npermalink: /glossary/\n');
    expect(merge(site)).toContain("title_key: navigation.glossary\n---");
  });
});

describe("a key that is already there, in any spelling YAML allows", () => {
  it.each([
    ["plain", "title_key: navigation.glossary\n"],
    ["quoted key", '"title_key": navigation.glossary\n'],
    ["quoted value", 'title_key: "navigation.glossary"\n'],
    ["an author's own value", "title_key: navigation.home\n"],
    ["deliberately empty", "title_key:\n"],
    ["empty, with a comment", "title_key: # left empty on purpose\n"],
  ])("%s is left alone", (_label, line) => {
    const site = glossary(`layout: glossary-index\ntitle: Glossary\npermalink: /glossary/\n${line}`);
    expect(merge(site)).toBeNull();
  });
});

describe("a line that only looks like the key", () => {
  it.each([
    ["commented out", "# title_key: navigation.glossary\n"],
    ["a longer key", "title_key_extra: x\n"],
    ["inside a block scalar", "description: |\n  title_key: navigation.glossary\n"],
    ["inside a quoted value", 'note: "title_key: # not a key"\n'],
  ])("%s does not count as present", (_label, line) => {
    const site = glossary(`layout: glossary-index\ntitle: Glossary\npermalink: /glossary/\n${line}`);
    expect(merge(site)).toContain("title_key: navigation.glossary\n---");
  });
});

describe("a file the merge will not touch", () => {
  it("has no frontmatter", () => {
    expect(merge(AUTHOR_BODY)).toBeNull();
  });

  it("has a block that never closes", () => {
    expect(merge("---\ntitle: Glossary\n\nbody\n")).toBeNull();
  });

  it("has a block that is not valid YAML", () => {
    expect(merge(glossary("title: [unclosed\n"))).toBeNull();
  });

  it("has a block that is not a mapping", () => {
    expect(merge(glossary("- just\n- a list\n"))).toBeNull();
  });

  it("has a flow mapping, which a line appended to its end would break", () => {
    expect(merge(glossary("{layout: glossary-index, title: Glossary}\n"))).toBeNull();
  });

  it("is not one of the built-in pages", () => {
    expect(mergeFrameworkFrontmatter("pages/about.md", glossary("title: About\n"), RELEASE["index.md"])).toBeNull();
  });
});

describe("the merge across an upgrade's files", () => {
  const found = (path: string): Promise<TargetPage> =>
    Promise.resolve({ kind: "found", content: RELEASE[path] });

  it("puts a page into the upgrade only when it changed", async () => {
    const files = new Map<string, string>();
    const current = RELEASE["pages/objects.md"];
    const report = await applyBuiltInPageFrontmatter(files, {
      site: async (path) =>
        path === "pages/objects.md" ? current : RELEASE[path].replace(/^title_key: .*\n/m, ""),
      target: found,
    });

    expect(report.merged.sort()).toEqual(["index.md", "pages/glossary.md"]);
    expect(files.has("pages/objects.md")).toBe(false);
  });

  it("merges into a page an earlier transform already changed, not the repository's copy", async () => {
    const files = new Map([["pages/glossary.md", glossary("layout: glossary-index\ntitle: Glossary\npermalink: /glossary/\n", "\nnew body\n")]]);
    await applyBuiltInPageFrontmatter(files, {
      site: async () => "never read",
      target: found,
    });

    expect(files.get("pages/glossary.md")).toContain("new body");
    expect(files.get("pages/glossary.md")).toContain("title_key: navigation.glossary");
  });

  it("delivers keys, not files: a page the site lacks stays absent", async () => {
    const files = new Map<string, string>();
    await applyBuiltInPageFrontmatter(files, { site: async () => null, target: found });
    expect(files.size).toBe(0);
  });

  it("reports a release copy it could not read, and leaves the page as it was", async () => {
    // Not guessed at: an outage is not an answer about what the release ships.
    const files = new Map<string, string>();
    const report = await applyBuiltInPageFrontmatter(files, {
      site: async (path) => RELEASE[path].replace(/^title_key: .*\n/m, ""),
      target: async () => ({ kind: "failed" }),
    });

    expect(report.unread.sort()).toEqual(Object.keys(BUILT_IN_PAGES).sort());
    expect(files.size).toBe(0);
  });
});

describe("what an upgrade adds survives the next publish", () => {
  const landing = {
    stories_heading: null,
    stories_intro: null,
    objects_heading: null,
    objects_intro: null,
    welcome_body: null,
  };

  it("keeps title_key and layout on a republished index.md", () => {
    const upgraded = mergeFrameworkFrontmatter(
      "index.md",
      "---\nlayout: index\ntitle: Home\n---\n\nWelcome.\n",
      RELEASE["index.md"],
    ) as string;

    const published = indexMdForPublish(upgraded, landing);

    expect(published).toContain("layout: index");
    expect(published).toContain("title_key: navigation.home");
  });

  it("keeps them on a CRLF file", () => {
    const upgraded = mergeFrameworkFrontmatter(
      "index.md",
      "---\r\nlayout: index\r\ntitle: Home\r\n---\r\n\r\nWelcome.\r\n",
      RELEASE["index.md"],
    ) as string;

    const published = indexMdForPublish(upgraded, landing);

    expect(published).toContain("layout: index");
    expect(published).toContain("title_key: navigation.home");
    expect(published).toContain("Welcome.");
  });

  it("writes the framework's own lines on a first publish with no file", () => {
    const published = indexMdForPublish(null, landing);
    expect(published.startsWith("---\nlayout: index\ntitle: Home\ntitle_key: navigation.home\n---")).toBe(true);
  });
});
