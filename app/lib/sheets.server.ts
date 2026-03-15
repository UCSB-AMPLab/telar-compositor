/**
 * Google Sheets utilities for the Telar Compositor import pipeline.
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
 */

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
export function sheetsCsvUrl(publishedId: string, gid: string): string {
  return `https://docs.google.com/spreadsheets/d/e/${publishedId}/pub?gid=${gid}&single=true&output=csv`;
}

/**
 * Discovers tab names and GIDs from a published Google Sheet's HTML page.
 *
 * Fetches the published HTML and parses JavaScript `items.push()` calls to
 * extract tab metadata. Skips tabs named "instructions", "instrucciones",
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
  const tabs: Array<{ name: string; gid: string }> = [];

  for (const match of html.matchAll(pattern)) {
    const name = match[1];
    const gid = match[2];
    if (!SKIP_TABS.has(name.toLowerCase())) {
      tabs.push({ name, gid });
    }
  }

  return tabs;
}

/**
 * Fetches a single tab from a published Google Sheet as CSV text.
 *
 * Throws an error if the response looks like HTML instead of CSV — this
 * indicates the sheet is not publicly accessible (e.g. the published URL
 * is wrong or access has been revoked). The caller must handle this error
 * and surface it to the user — do NOT fall back to repo CSVs.
 */
export async function fetchSheetCsv(
  publishedId: string,
  gid: string,
): Promise<string> {
  const url = sheetsCsvUrl(publishedId, gid);
  const res = await fetch(url);
  const text = await res.text();

  if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
    throw new Error(
      `Google Sheets returned HTML instead of CSV — sheet may not be publicly accessible. URL: ${url}`,
    );
  }

  return text;
}
