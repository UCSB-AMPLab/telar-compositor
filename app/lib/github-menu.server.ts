/**
 * Reading GitHub's menu, `_data/navigation.yml`, for the entry of a page
 * taken from GitHub.
 *
 * The file is the framework's: a `menu:` list whose items carry `title_en`,
 * `titulo_es` and `url`, and `external: true` for a link out of the site. An
 * item names a page when its `url`, without its leading and trailing `/`, is
 * the address the site builds the page at. That address is not the file name:
 * the pages collection is `permalink: /:name/`, `generate_pages` keeps the
 * file name, and Jekyll's `:name` is `Utils.slugify(basename_without_ext)` in
 * its default mode (jekyll 4.4.1, `drops/url_drop.rb`), so `Mi Página.md` is
 * built at `/mi-página/` and `credits_two.md` at `/credits-two/`. An external
 * item never names a page.
 *
 * The entry is labelled as the framework's header reads the item
 * (`_includes/header.html`): `titulo_es` on a Spanish site, else `title_en`,
 * each falling back to the other. It goes directly after the saved entry for
 * the item before it in GitHub's menu, and at the end when there is no such
 * item or the saved menu does not hold it. A page a saved entry already
 * names, a page no item names and a file that is absent or does not parse get
 * none.
 *
 * Server-only: the parse uses js-yaml.
 *
 * @version v1.5.0-beta
 */

import { DEFAULT_SCHEMA, Type, load } from "js-yaml";
import { isYamlMapping } from "~/lib/yaml.server";
import { siteAddressOfPage } from "~/lib/jekyll-slug";
import { telarLanguageOf } from "~/lib/one-language-pages";
import type { NavItemLike } from "~/lib/yjs-helpers";

/** One item of GitHub's menu. */
export interface GithubMenuItem {
  titleEn: string | null;
  tituloEs: string | null;
  url: string;
  external: boolean;
}

/** The entry for an added page, and where it goes among the saved entries. */
export interface AddedPageMenu {
  entry: { type: "page"; slug: string; label: string; visible: true };
  /** The index in the saved menu the entry is inserted at; the saved length for the end. */
  index: number;
}

/** The built-in sections' addresses, as `BUILTIN_NAV` in the publish writes them. */
const BUILTIN_ADDRESSES: Record<string, string> = { collection: "objects", glossary: "glossary" };

/**
 * The framework reads the file with Ruby's Psych, whose plain `yes`, `true`
 * and `on` (and `no`, `false`, `off`) are booleans in any case, and a quoted
 * scalar is a string. js-yaml's default schema resolves `true` and `false`
 * alone.
 */
const PSYCH_BOOL = new Type("tag:yaml.org,2002:bool", {
  kind: "scalar",
  resolve: (data: string) => /^(?:yes|true|on|no|false|off)$/i.test(data),
  construct: (data: string) => /^(?:yes|true|on)$/i.test(data),
  predicate: (object: unknown) => typeof object === "boolean",
  represent: (object: unknown) => (object ? "true" : "false"),
  defaultStyle: "lowercase",
});
const PSYCH_SCHEMA = DEFAULT_SCHEMA.extend({ implicit: [PSYCH_BOOL] });

/** An item's `url` with its leading and trailing `/` removed and any percent-encoding read. */
function addressOfUrl(url: string): string {
  const trimmed = url.trim().replace(/^\/+|\/+$/g, "");
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** A scalar the header would render, as text; null for what Liquid's `default` replaces. */
function scalarText(value: unknown): string | null {
  if (typeof value === "number" || value === true) return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * GitHub's menu items, or null when the file is absent, does not parse, or
 * holds no `menu:` list. An item that is not a mapping or has no `url` is
 * skipped: it can neither name a page nor be the one before it.
 */
export function parseGithubMenu(text: string | null): GithubMenuItem[] | null {
  if (text === null) return null;
  let doc: unknown;
  try {
    doc = load(text, { schema: PSYCH_SCHEMA, json: true });
  } catch {
    return null;
  }
  if (!isYamlMapping(doc) || !Array.isArray(doc.menu)) return null;
  const items: GithubMenuItem[] = [];
  for (const raw of doc.menu) {
    if (!isYamlMapping(raw)) continue;
    const url = scalarText(raw.url);
    if (url === null) continue;
    items.push({
      titleEn: scalarText(raw.title_en),
      tituloEs: scalarText(raw.titulo_es),
      url,
      // The header tests `item.external` as Liquid does: anything but nil and
      // false is true, a quoted "no" included.
      external: raw.external !== undefined && raw.external !== null && raw.external !== false,
    });
  }
  return items;
}

/** The index of the saved entry the menu item stands for, or -1. */
function savedIndexOf(item: GithubMenuItem, saved: readonly NavItemLike[]): number {
  if (item.external) return saved.findIndex((s) => s.type === "external" && s.url === item.url);
  const address = addressOfUrl(item.url);
  if (address === "") return saved.findIndex((s) => s.type === "builtin" && s.key === "home");
  const builtinKey = Object.keys(BUILTIN_ADDRESSES).find((key) => BUILTIN_ADDRESSES[key] === address);
  if (builtinKey) return saved.findIndex((s) => s.type === "builtin" && s.key === builtinKey);
  return saved.findIndex((s) => s.type === "page" && !!s.slug && siteAddressOfPage(s.slug) === address);
}

/** The menu entry GitHub's file gives an added page, or null for none. */
export function menuEntryForAddedPage(input: {
  slug: string;
  menu: GithubMenuItem[] | null;
  saved: readonly NavItemLike[];
  siteLanguage: unknown;
}): AddedPageMenu | null {
  const { slug, menu, saved, siteLanguage } = input;
  if (menu === null || saved.some((s) => s.type === "page" && s.slug === slug)) return null;
  const address = siteAddressOfPage(slug);
  if (address === "") return null;
  const at = menu.findIndex((item) => !item.external && addressOfUrl(item.url) === address);
  if (at < 0) return null;
  const item = menu[at];
  return {
    entry: { type: "page", slug, label: menuItemLabel(item, siteLanguage), visible: true },
    index: indexAfterPrevious(menu, at, saved),
  };
}

/** The label the site's language reads from a menu item: its own title, else the other language's, else empty. */
function menuItemLabel(item: GithubMenuItem, siteLanguage: unknown): string {
  const spanish = telarLanguageOf(siteLanguage) === "es";
  return (spanish ? item.tituloEs ?? item.titleEn : item.titleEn ?? item.tituloEs) ?? "";
}

/** Where an added page goes in the saved entries: after the entry the menu item before it stands for, else last. */
function indexAfterPrevious(menu: GithubMenuItem[], at: number, saved: readonly NavItemLike[]): number {
  const before = at > 0 ? savedIndexOf(menu[at - 1], saved) : -1;
  return before >= 0 ? before + 1 : saved.length;
}
