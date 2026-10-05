/**
 * The two built-in page lines the 1.8.0 upgrade brings up to date:
 * the manifest's guarded `regex_replace` over `index.md` and
 * `pages/glossary.md` from the 1.7.0 template, a line the author changed left
 * alone, and the upgraded `index.md` read back through import as the default
 * welcome, and a 1.2.x site's default pages, which the v1.3.0 ingest rewrites
 * after the chain, ending with the 1.8.0 lines. The fixtures are described in
 * `fixtures/upgrade-1.8.0/NOTES.md`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyManifestChain } from "~/lib/manifest-runner.server";
import { validateManifest } from "~/lib/manifest-schema.server";
import { applyV130Transforms, isV130WelcomeLiquidBlock, V121_BODIES } from "~/lib/v130-ingest.server";
import { reapplyBuiltInPageEdits } from "~/lib/upgrade.server";
import { parseIndexMd } from "~/lib/import.server";

const FIXTURES = join(__dirname, "fixtures", "upgrade-1.8.0");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

const MANIFEST = validateManifest(JSON.parse(fixture("migration.json")));

const WELCOME_170 = "{{ lang.index_page.welcome | markdownify }}";
const WELCOME_180 = "{{ lang.index_page.welcome | default: site.data.languages.en.index_page.welcome | markdownify }}";
const GLOSSARY_170 = "{{ lang.pages.glossary_intro }}";
const GLOSSARY_180 = "{% include glossary-intro.html lang=lang %}";

const INDEX = fixture("index-v1.7.0.md");
const GLOSSARY = fixture("glossary-v1.7.0.md");

/** The pages after the 1.8.0 manifest, for a site in `lang`. */
function upgrade(pages: Record<string, string>, lang: "en" | "es"): Map<string, string> {
  const files = new Map([["_config.yml", fixture("config-v1.7.0.yml")], ...Object.entries(pages)]);
  return applyManifestChain([MANIFEST], files, lang).files;
}

describe("the 1.8.0 page lines over the 1.7.0 template", () => {
  for (const lang of ["en", "es"] as const) {
    describe(`a site in ${lang}`, () => {
      const out = upgrade({ "index.md": INDEX, "pages/glossary.md": GLOSSARY }, lang);

      it("gives index.md the 1.8.0 welcome line, as the 1.8.0 template has it", () => {
        expect(INDEX).toContain(WELCOME_170);
        expect(out.get("index.md")).toBe(fixture("index-0dd90d52.md"));
      });

      it("gives pages/glossary.md the 1.8.0 introduction line and changes nothing else", () => {
        expect(out.get("pages/glossary.md")).toBe(GLOSSARY.replace(GLOSSARY_170, GLOSSARY_180));
        expect(out.get("pages/glossary.md")).not.toContain(GLOSSARY_170);
      });

      it("changes nothing on a second run", () => {
        const again = upgrade({ "index.md": out.get("index.md")!, "pages/glossary.md": out.get("pages/glossary.md")! }, lang);
        expect(again.get("index.md")).toBe(out.get("index.md"));
        expect(again.get("pages/glossary.md")).toBe(out.get("pages/glossary.md"));
      });
    });
  }

  it("replaces the line in a file with CRLF endings, keeping them", () => {
    const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
    const out = upgrade({ "index.md": crlf(INDEX), "pages/glossary.md": crlf(GLOSSARY) }, "en");
    expect(out.get("index.md")).toBe(crlf(fixture("index-0dd90d52.md")));
    expect(out.get("pages/glossary.md")).toBe(crlf(GLOSSARY.replace(GLOSSARY_170, GLOSSARY_180)));
  });

  it("leaves a line the author changed, indented or extended", () => {
    const pages = {
      "index.md": INDEX.replace(WELCOME_170, `${WELCOME_170} Welcome to our site.`),
      "pages/glossary.md": GLOSSARY.replace(GLOSSARY_170, `  ${GLOSSARY_170}`),
    };
    const out = upgrade(pages, "en");
    expect(out.get("index.md")).toBe(pages["index.md"]);
    expect(out.get("pages/glossary.md")).toBe(pages["pages/glossary.md"]);
  });

  it("leaves a page whose author replaced the line with their own text", () => {
    const own = INDEX.replace(WELCOME_170, "## Welcome\n\nOur own words.");
    expect(upgrade({ "index.md": own }, "es").get("index.md")).toBe(own);
  });
});

describe("the upgraded index.md read back", () => {
  const upgraded = upgrade({ "index.md": INDEX }, "en").get("index.md")!;

  it("is the default welcome block, so import stores no welcome of the author's own", () => {
    expect(upgraded).toContain(WELCOME_180);
    expect(isV130WelcomeLiquidBlock(upgraded.slice(upgraded.indexOf("{% assign")))).toBe(true);
    expect(parseIndexMd(upgraded).welcome_body).toBeUndefined();
  });

  it("still reads the 1.7.0 line as the default welcome", () => {
    expect(parseIndexMd(INDEX).welcome_body).toBeUndefined();
  });

  it("reads a page with the author's own welcome as their text", () => {
    const own = upgraded.replace(WELCOME_180, "## Welcome\n\nOur own words.");
    expect(parseIndexMd(own).welcome_body).toContain("Our own words.");
  });

  it("does not take a different fallback for the default", () => {
    const other = upgraded.replace(WELCOME_180, WELCOME_180.replace("languages.en.", "languages.es."));
    expect(isV130WelcomeLiquidBlock(other)).toBe(false);
  });
});

describe("a 1.2.x site upgraded straight to 1.8.0", () => {
  const INDEX_121 = `---\nlayout: index\ntitle: Home\n---\n\n${V121_BODIES.index}\n`;
  const GLOSSARY_121 = `---\nlayout: glossary-index\ntitle: Glossary\n---\n\n${V121_BODIES.glossary}\n`;

  /** The chain, then the v1.3.0 ingest, then (when asked) the page edits again, as prepare runs them. */
  async function upgrade121(reapply: boolean): Promise<Map<string, string>> {
    const files = upgrade({ "index.md": INDEX_121, "pages/glossary.md": GLOSSARY_121 }, "en");
    await applyV130Transforms(files, "en");
    if (reapply) reapplyBuiltInPageEdits([MANIFEST], files, "en");
    return files;
  }

  it("ends with the 1.8.0 page lines once the page edits run again after the ingest", async () => {
    const files = await upgrade121(true);
    expect(files.get("index.md")!.endsWith(`${WELCOME_180}\n`)).toBe(true);
    expect(files.get("pages/glossary.md")!.endsWith(`${GLOSSARY_180}\n`)).toBe(true);
    expect(files.get("index.md")).not.toContain(WELCOME_170);
  });

  it("is left with the 1.3.0 lines the ingest writes when the edits do not run again", async () => {
    const files = await upgrade121(false);
    expect(files.get("index.md")!.endsWith(`${WELCOME_170}\n`)).toBe(true);
    expect(files.get("pages/glossary.md")!.endsWith(`${GLOSSARY_170}\n`)).toBe(true);
  });

  it("runs again only the edits that name a built-in page literally", () => {
    const chain = [
      validateManifest({
        schema_version: 1,
        from_version: "1.7.0",
        to_version: "1.8.0",
        description: "test",
        operations: [
          { type: "regex_replace", file_glob: "_config.yml", search: "x", replace: "xx" },
          { type: "regex_replace", file_glob: "**/*.md", search: "y", replace: "yy" },
          { type: "regex_replace", file_glob: "pages/objects.md", search: "z", replace: "zz" },
        ],
        manual_steps: { en: [], es: [] },
      }),
    ];
    const files = new Map([
      ["_config.yml", "x"],
      ["index.md", "y"],
      ["pages/objects.md", "z"],
    ]);
    reapplyBuiltInPageEdits(chain, files, "en");
    expect(Object.fromEntries(files)).toEqual({ "_config.yml": "x", "index.md": "y", "pages/objects.md": "zz" });
  });
});
