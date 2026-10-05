/**
 * Google Sheets utilities for the Telar Compositor's import and upgrade.
 *
 * Supports importing from publicly published Google Sheets. The approach
 * mirrors Telar's own Python scripts (fetch_google_sheets.py +
 * discover_sheet_gids.py) — these are the source of truth for URL format
 * and tab discovery logic.
 *
 * Published CSV export URL format:
 *   https://docs.google.com/spreadsheets/d/e/{publishedId}/pub?gid={gid}&single=true&output=csv
 *
 * Tab GIDs are discovered by fetching the published HTML page and parsing
 * the `items.push({name: "...", gid: "..."})` JavaScript pattern.
 *
 * @version v1.5.0-beta
 */

import { pythonLower } from "~/lib/python-lower";
import { decodeHTML } from "entities/decode";
import { htmlUnescape } from "~/lib/html-unescape";
import { pythonStrip } from "~/lib/python-whitespace";

// Tabs to exclude — these are template/documentation tabs, not content
const SKIP_TABS = new Set(["instructions", "instrucciones", "readme", "help", "info"]);

/**
 * Extracts the published sheet ID from a Google Sheets published URL.
 *
 * Published URLs contain `/d/e/{id}/` — shared URLs (browser address bar)
 * do NOT contain this pattern and will return null.
 *
 * Example published URL:
 *   https://docs.google.com/spreadsheets/d/e/2PACX-1vAbCdEfGh/pubhtml
 * Returns: "2PACX-1vAbCdEfGh"
 */
export function extractPublishedId(url: string): string | null {
  const match = url.match(/\/d\/e\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

/**
 * Builds the CSV export URL for a specific tab in a published Google Sheet.
 */
function sheetsCsvUrl(publishedId: string, gid: string): string {
  return `https://docs.google.com/spreadsheets/d/e/${publishedId}/pub?gid=${gid}&single=true&output=csv`;
}

/**
 * Discovers tab names and GIDs from a published Google Sheet's HTML page.
 *
 * Fetches the published HTML and parses JavaScript `items.push()` calls to
 * extract tab metadata, falling back as the build does to the `sheet-button-*`
 * elements and then to bare `gid=` numbers named `Tab N`. Skips tabs named "instructions", "instrucciones",
 * "readme", "help", or "info" (case-insensitive) — these are template tabs,
 * not content.
 */
export async function discoverSheetTabs(
  publishedHtmlUrl: string,
): Promise<Array<{ name: string; gid: string }>> {
  const res = await fetch(publishedHtmlUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch published sheet HTML: ${res.status}`);
  }
  const html = await res.text();

  const pattern = /items\.push\(\{name:\s*"([^"]+)"[^}]*gid:\s*"(\d+)"/g;
  const found = [...html.matchAll(pattern)].map((m) => ({ name: m[1], gid: m[2] }));
  // discover_sheet_gids.py:126-140 and :142-158: the build reads `items.push`
  // first, then the `sheet-button-*` markup, then bare `gid=` numbers; the
  // first that finds anything is the answer.
  const buttons = found.length > 0 ? null : sheetButtonTabs(html);
  const tabs = found.length > 0 ? found : buttons === "raised" ? [] : (buttons ?? bareGidTabs(html));
  return tabs.filter((tab) => !SKIP_TABS.has(tab.name.toLowerCase()));
}

/**
 * Python's `html.unescape`, which `HTMLParser` applies to text and attribute
 * values. Numeric references use the port in html-unescape.ts; a named one goes
 * to `entities`' legacy-aware HTML5 decoder, which takes the full name table and
 * the semicolonless legacy names by longest prefix, as Python does.
 */
function pythonUnescape(text: string): string {
  return text.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (ref, body: string) =>
    body[0] === "#" ? htmlUnescape(ref) : decodeHTML(ref),
  );
}

/**
 * `SheetTabParser` (discover_sheet_gids.py:62-95) over `html`: an element
 * whose id starts `sheet-button-` opens a tab, an `<a href>` carrying `gid=`
 * while it is open replaces the id's gid, and the next non-blank text, with
 * references decoded and stripped, names it. A gid already taken is skipped,
 * and one text closes the button either way. An `id` attribute with no value
 * (or an `<a href>` with none) raises in the Python, which answers no tabs at all;
 * "raised" here, so the bare-gid reading is not tried either. null is a page
 * that parsed and named no tab.
 */
function sheetButtonTabs(html: string): Array<{ name: string; gid: string }> | "raised" | null {
  const state: ButtonState = { tabs: [], open: false, gid: null };
  const markup = /<!--[\s\S]*?-->|<[!?][^>]*>|<\/[a-zA-Z][^>]*>|<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = markup.exec(html)) !== null) {
    if (m.index > last) nameOpenButton(state, pythonUnescape(html.slice(last, m.index)));
    last = markup.lastIndex;
    if (m[1] === undefined) continue;
    const tag = m[1].toLowerCase();
    if (!openButtonFromTag(state, tag, readAttributes(m[2]))) return "raised";
    const rawEnd = rawTextEnd(html, last, tag);
    if (rawEnd !== null) {
      nameOpenButton(state, html.slice(last, rawEnd));
      last = rawEnd;
      markup.lastIndex = last;
    }
  }
  if (last < html.length) nameOpenButton(state, pythonUnescape(html.slice(last)));
  return state.tabs.length > 0 ? state.tabs : null;
}

interface ButtonState {
  tabs: Array<{ name: string; gid: string }>;
  open: boolean;
  gid: string | null;
}

/** `handle_data` (discover_sheet_gids.py:87-95): the first non-blank text after a button opens names it. */
function nameOpenButton(state: ButtonState, data: string): void {
  const name = pythonStrip(data);
  if (!state.open || name === "") return;
  if (state.gid !== null && !state.tabs.some((t) => t.gid === state.gid)) state.tabs.push({ name, gid: state.gid });
  state.open = false;
}

/** `dict(attrs)` of a start tag: names lowercased, values decoded, a bare attribute null. */
function readAttributes(source: string): Map<string, string | null> {
  const attrs = new Map<string, string | null>();
  for (const a of source.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g)) {
    const v = a[2] === undefined ? null : pythonUnescape(/^["']/.test(a[2]) ? a[2].slice(1, -1) : a[2]);
    attrs.set(a[1].toLowerCase(), v);
  }
  return attrs;
}

/** `handle_starttag` (discover_sheet_gids.py:70-85); false where the Python raises on a valueless `id` or `href`. */
function openButtonFromTag(state: ButtonState, tag: string, attrs: Map<string, string | null>): boolean {
  const id = attrs.get("id");
  const href = tag === "a" ? attrs.get("href") : undefined;
  if (id === null || href === null) return false;
  if (id?.startsWith("sheet-button-")) {
    state.open = true;
    state.gid = id.replace("sheet-button-", "");
  }
  const hrefGid = href ? /gid=(\d+)/.exec(href) : null;
  if (hrefGid && state.open) state.gid = hrefGid[1];
  return true;
}

/** Where the raw text of a `<script>` or `<style>` opened at `from` ends, or null for any other tag. */
function rawTextEnd(html: string, from: number, tag: string): number | null {
  if (tag !== "script" && tag !== "style") return null;
  const close = new RegExp(`</${tag}`, "i").exec(html.slice(from));
  return close ? from + close.index : null;
}

/**
 * The bare-gid reading (discover_sheet_gids.py:144-156): every distinct
 * `gid=<digits>` except `0`, ordered by numeric value and named `Tab 1`, `Tab 2`
 * from 1. Python's `\d` also takes non-ASCII digits and its set orders
 * equal-valued gids such as `01` and `1` arbitrarily; neither is modelled.
 */
function bareGidTabs(html: string): Array<{ name: string; gid: string }> {
  const gids = [...new Set([...html.matchAll(/gid=(\d+)/g)].map((m) => m[1]))].filter((g) => g !== "0");
  gids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return gids.map((gid, i) => ({ name: `Tab ${i + 1}`, gid }));
}

/**
 * Fetches a single tab from a published Google Sheet as CSV text, read as the
 * build's `fetch_csv` (scripts/fetch_google_sheets.py) reads it: an answer
 * other than 2xx fails, the bytes are decoded as strict UTF-8 with a
 * byte-order mark kept, and an answer whose text starts with `<!DOCTYPE` or
 * `<html`, untrimmed, is a page rather than CSV (the sheet is not public, or
 * the URL is wrong). Each of these throws; the caller must surface it, never
 * fall back to the repository's CSVs.
 */
export async function fetchSheetCsv(
  publishedId: string,
  gid: string,
): Promise<string> {
  const url = sheetsCsvUrl(publishedId, gid);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Sheets answered ${res.status} for ${url}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await res.arrayBuffer());

  if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
    throw new Error(
      `Google Sheets returned HTML instead of CSV — sheet may not be publicly accessible. URL: ${url}`,
    );
  }

  return text;
}

/**
 * `text` without the trailing lines the build strips from a fetched tab: a
 * published sheet exports its blank rows too, and an unchecked checkbox
 * exports `FALSE`. A port of fetch_google_sheets.py's loop, splitting on
 * commas without reading quotes, so a quoted `"FALSE"` is kept.
 */
export function stripTrailingSheetRows(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0) {
    const cells = pythonStrip(lines[lines.length - 1]).split(",");
    if (!cells.every((c) => ["", "FALSE"].includes(pythonStrip(c)))) break;
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The file the build writes a tab to in the spreadsheets directory, or null
 * for a tab it does not fetch (fetch_google_sheets.py's loop): the instruction
 * tabs, and a tab whose name starts with `#`. The project, objects and
 * glossary tabs keep their language's name; any other tab is its name,
 * lowercased as Python lowercases it.
 */
export function tabFileName(tabName: string): string | null {
  const lower = pythonLower(tabName);
  if (SKIP_TABS.has(lower) || lower.startsWith("#")) return null;
  return `${lower}.csv`;
}

/** A published tab the build fetches, with the file it writes and its text as written. */
export interface PublishedTab {
  name: string;
  gid: string;
  file: string;
  text: string;
}

/** A published sheet that could not be read: one of its tabs, by name, or, where `tab` is null, the sheet as a whole. */
export class PublishedSheetUnreadableError extends Error {
  constructor(readonly tab: string | null = null) {
    super(tab === null ? "The published Google Sheet could not be read" : `A tab of the published Google Sheet could not be read: ${tab}`);
    this.name = "PublishedSheetUnreadableError";
  }
}

/**
 * Every tab the build fetches from the sheet published at `publishedUrl`, in
 * the order the sheet lists them, each with the text the build writes. Fails
 * where the build's fetch would not give the site that tab: the URL holds no
 * published id, the tabs cannot be listed or none is fetched, or a tab cannot
 * be read. Used by the upgrade only; import reads tabs on its own terms.
 */
export async function readPublishedTabs(publishedUrl: string): Promise<PublishedTab[]> {
  const publishedId = extractPublishedId(publishedUrl);
  const listed = publishedId === null ? [] : await discoverSheetTabs(publishedUrl).catch(() => []);
  const tabs: PublishedTab[] = [];
  for (const { name, gid } of listed) {
    const file = tabFileName(name);
    if (file === null) continue;
    const text = await fetchSheetCsv(publishedId as string, gid).catch(() => {
      throw new PublishedSheetUnreadableError(name);
    });
    tabs.push({ name, gid, file, text: stripTrailingSheetRows(text) });
  }
  if (tabs.length === 0) throw new PublishedSheetUnreadableError();
  return tabs;
}
