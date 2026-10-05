/**
 * Reading GitHub's menu for a page taken from GitHub: the
 * framework's `_data/navigation.yml` format, the match of an item to a page
 * by the address the site gives it, the label by the site's language and the
 * position among the saved entries.
 *
 * The menu text is the template's `_data/navigation.yml` with the custom
 * page example from its comments uncommented.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { menuEntryForAddedPage, parseGithubMenu } from "~/lib/github-menu.server";
import { siteAddressOfPage } from "~/lib/jekyll-slug";
import type { NavItemLike } from "~/lib/yjs-helpers";

const TEMPLATE_MENU = `menu:
  - title_en: Home
    titulo_es: Inicio
    url: /

  - title_en: Objects
    titulo_es: Objetos
    url: /objects/

  - title_en: Glossary
    titulo_es: Glosario
    url: /glossary/

  - title_en: About
    titulo_es: Acerca de
    url: /about/

  - title_en: Credits
    titulo_es: Créditos
    url: /credits/

  - title_en: Project Repository
    titulo_es: Repositorio del proyecto
    url: https://github.com/your-org/your-repo
    external: true
`;

const menu = (text: string) => parseGithubMenu(text);
const page = (slug: string, label = slug): NavItemLike => ({ type: "page", slug, label, visible: true });
const builtin = (key: string, label = key): NavItemLike => ({ type: "builtin", key, label, visible: true });
const external = (url: string): NavItemLike => ({ type: "external", url, label: "Repo", visible: true });

const SAVED: NavItemLike[] = [builtin("home"), builtin("collection"), builtin("glossary"), page("about", "About")];

function entryFor(
  slug: string,
  text: string | null,
  over: Partial<Parameters<typeof menuEntryForAddedPage>[0]> = {},
) {
  return menuEntryForAddedPage({
    slug,
    menu: text === null ? null : menu(text),
    saved: SAVED,
    siteLanguage: "en",
    ...over,
  });
}

describe("the address the site gives a page (Jekyll's :name)", () => {
  // Jekyll 4.4.1, lib/jekyll/drops/url_drop.rb: `name` is
  // Utils.slugify(basename_without_ext) in the default mode, which turns each
  // run of characters outside \p{M}\p{L}\p{Nd} into one hyphen, trims a
  // hyphen at either end and lowercases. The framework's pages collection is
  // `permalink: /:name/` and generate_pages keeps the file name.
  it.each([
    ["credits", "credits"],
    ["Credits", "credits"],
    ["credits_two", "credits-two"],
    ["Mi Página", "mi-página"],
    ["a  b.c", "a-b-c"],
    ["-lead-", "lead"],
    ["Ñandú 2", "ñandú-2"],
    // Ruby's downcase, as Jekyll runs it, gives οσ; the framework's Python jekyll_slug gives ος.
    ["ΟΣ", "οσ"],
  ])("%s is built at /%s/", (slug, address) => {
    expect(siteAddressOfPage(slug)).toBe(address);
  });
});

describe("matching an item to a page by url", () => {
  it.each(["/credits/", "credits/", "/credits", "credits"])("an item at %s names credits", (url) => {
    const text = `menu:\n  - title_en: Credits\n    url: ${url}\n`;
    expect(entryFor("credits", text)?.entry.slug).toBe("credits");
  });

  it("labels it with title_en on an English site", () => {
    expect(entryFor("credits", TEMPLATE_MENU)?.entry).toEqual({
      type: "page",
      slug: "credits",
      label: "Credits",
      visible: true,
    });
  });

  it("labels it with titulo_es on a Spanish site", () => {
    expect(entryFor("credits", TEMPLATE_MENU, { siteLanguage: "es" })?.entry.label).toBe("Créditos");
  });

  it("falls back to the other language when the site's is missing or empty", () => {
    const onlyEn = "menu:\n  - title_en: Credits\n    url: /credits/\n";
    const onlyEs = 'menu:\n  - titulo_es: Créditos\n    title_en: ""\n    url: /credits/\n';
    expect(entryFor("credits", onlyEn, { siteLanguage: "es" })?.entry.label).toBe("Credits");
    expect(entryFor("credits", onlyEs, { siteLanguage: "en" })?.entry.label).toBe("Créditos");
  });

  it("reads an empty language setting as English", () => {
    expect(entryFor("credits", TEMPLATE_MENU, { siteLanguage: "" })?.entry.label).toBe("Credits");
  });

  it("never matches an external item whose url equals the slug", () => {
    const text = "menu:\n  - title_en: Credits\n    url: credits\n    external: true\n";
    expect(entryFor("credits", text)).toBeNull();
  });

  // Ruby 3.2.11, Psych 5.0.1: YAML.safe_load gives true for plain yes, Yes, on,
  // true, TRUE and tRuE, false for no, off and false, and the string "no" for
  // a quoted scalar.
  it.each(["yes", "Yes", "on", "true", "TRUE", "tRuE", '"no"', '"yes"', '"true"', "y"])("external: %s is external, as Psych reads it and Liquid tests it", (value) => {
    const text = `menu:\n  - title_en: Credits\n    url: /credits/\n    external: ${value}\n`;
    expect(menu(text)?.[0].external).toBe(true);
    expect(entryFor("credits", text)).toBeNull();
  });

  it.each(["no", "off", "false", "~", ""])("external: %s is not external", (value) => {
    const text = `menu:\n  - title_en: Credits\n    url: /credits/\n    external: ${value}\n`;
    expect(menu(text)?.[0].external).toBe(false);
    expect(entryFor("credits", text)?.entry.slug).toBe("credits");
  });

  it("matches the address the site builds, not the file name as typed", () => {
    const text = "menu:\n  - title_en: Mi página\n    url: /mi-página/\n";
    expect(entryFor("Mi Página", text)?.entry.slug).toBe("Mi Página");
    const encoded = "menu:\n  - title_en: Mi página\n    url: /mi-p%C3%A1gina/\n";
    expect(entryFor("Mi Página", encoded)?.entry.slug).toBe("Mi Página");
    // The item a site links at the file name as typed is not the page's address.
    const typed = "menu:\n  - title_en: Mi página\n    url: /Mi Página/\n";
    expect(entryFor("Mi Página", typed)).toBeNull();
    const underscore = "menu:\n  - title_en: Two\n    url: /credits_two/\n";
    expect(entryFor("credits_two", underscore)).toBeNull();
    const hyphen = "menu:\n  - title_en: Two\n    url: /credits-two/\n";
    expect(entryFor("credits_two", hyphen)?.entry.slug).toBe("credits_two");
  });

  it("a slug with no letters or digits has no address and never matches the home item", () => {
    expect(entryFor("---", "menu:\n  - title_en: Home\n    url: /\n")).toBeNull();
  });

  it("does not match an item at a nested address or another page", () => {
    expect(entryFor("credits", "menu:\n  - title_en: X\n    url: /a/credits/\n")).toBeNull();
    expect(entryFor("credit", TEMPLATE_MENU)).toBeNull();
  });
});

describe("where the entry goes", () => {
  it("directly after the saved entry for the item before it, a page by slug", () => {
    expect(entryFor("credits", TEMPLATE_MENU)?.index).toBe(4);
    const saved = [builtin("home"), page("about"), builtin("glossary")];
    expect(entryFor("credits", TEMPLATE_MENU, { saved })?.index).toBe(2);
  });

  it("after a built-in matched by its address", () => {
    const text = "menu:\n  - title_en: Glossary\n    url: /glossary/\n  - title_en: Credits\n    url: /credits/\n";
    const saved = [builtin("glossary"), builtin("collection"), page("about")];
    expect(entryFor("credits", text, { saved })?.index).toBe(1);
  });

  it("after an external link matched by its url", () => {
    const text =
      "menu:\n  - title_en: Repo\n    url: https://example.org/r\n    external: true\n  - title_en: Credits\n    url: /credits/\n";
    const saved = [page("about"), external("https://example.org/r"), page("other")];
    expect(entryFor("credits", text, { saved })?.index).toBe(2);
  });

  it("at the end when the saved menu does not hold the item before it", () => {
    const saved = [builtin("home"), builtin("collection")];
    expect(entryFor("credits", TEMPLATE_MENU, { saved })?.index).toBe(2);
  });

  it("at the end when no item comes before it", () => {
    const text = "menu:\n  - title_en: Credits\n    url: /credits/\n";
    expect(entryFor("credits", text)?.index).toBe(SAVED.length);
  });

  it("an external item is never matched to a saved page of the same slug", () => {
    const text =
      "menu:\n  - title_en: About\n    url: about\n    external: true\n  - title_en: Credits\n    url: /credits/\n";
    expect(entryFor("credits", text)?.index).toBe(SAVED.length);
  });
});

describe("when there is no entry", () => {
  it("none for a page a saved entry already names", () => {
    expect(entryFor("credits", TEMPLATE_MENU, { saved: [...SAVED, page("credits", "Credits")] })).toBeNull();
  });

  it("none when no item names it", () => {
    expect(entryFor("history", TEMPLATE_MENU)).toBeNull();
  });

  it.each([
    ["absent", null],
    ["unparseable", "menu:\n  - title_en: [unclosed\n    url: /credits/"],
    ["not a mapping", "- just\n- a list\n"],
    ["menu not a list", "menu: credits\n"],
    ["empty", ""],
  ])("none for a file that is %s", (_name, text) => {
    expect(entryFor("credits", text)).toBeNull();
  });
});

describe("parsing the framework's format", () => {
  it("reads title_en, titulo_es, url and external", () => {
    expect(menu(TEMPLATE_MENU)?.at(-1)).toEqual({
      titleEn: "Project Repository",
      tituloEs: "Repositorio del proyecto",
      url: "https://github.com/your-org/your-repo",
      external: true,
    });
  });

  it("is null for a file that does not parse, or has no menu list", () => {
    expect(parseGithubMenu(null)).toBeNull();
    expect(parseGithubMenu("menu:\n  - title_en: [unclosed")).toBeNull();
    expect(parseGithubMenu("menu: credits\n")).toBeNull();
    expect(parseGithubMenu("")).toBeNull();
  });

  it("skips an item that is not a mapping or has no url", () => {
    const parsed = menu("menu:\n  - just text\n  - title_en: No url\n  - title_en: Ok\n    url: /ok/\n");
    expect(parsed?.map((i) => i.url)).toEqual(["/ok/"]);
  });
});
