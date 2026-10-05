/**
 * The published Google Sheets tabs an upgrade checks. A site whose
 * `_config.yml` turns Google Sheets on has its build fetch every tab into the
 * spreadsheets directory, over the repository's copies, before it converts
 * what is there; so the sheets that build reads are the repository's with
 * each tab written over them. The test is the build's, made on the
 * `_config.yml` the upgrade commits, since that is the file the first build
 * after it reads.
 *
 * @version v1.5.0-beta
 */

import { SPREADSHEETS_DIR } from "~/lib/framework-sheet.server";
import { isGoogleSheetsOn } from "~/lib/pyyaml";
import type { PublishedTab } from "~/lib/sheets.server";
import { configSheets } from "~/lib/unreadable-characters.server";

/** The tabs a Sheets site's build fetches, as the upgrade read them. */
export interface SiteTabs {
  /** Each tab read, by name and gid, in the sheet's order. */
  listed: { name: string; gid: string }[];
  /**
   * Each tab with the path in the spreadsheets directory the build opens for
   * it, in the order the build writes them; a later write to the same file
   * replaces an earlier one.
   */
  written: { path: string; tab: PublishedTab }[];
}

/**
 * The tabs the build fetches for `config`, or null when it fetches none. A
 * read that fails throws as `readTabs` throws.
 */
export async function readSiteTabs(
  config: string | undefined,
  readTabs: (publishedUrl: string) => Promise<PublishedTab[]>,
): Promise<SiteTabs | null> {
  if (config === undefined || !isGoogleSheetsOn(config)) return null;
  const tabs = await readTabs(configSheets(config)?.publishedUrl ?? "");
  return {
    listed: tabs.map(({ name, gid }) => ({ name, gid })),
    written: tabs.map((tab) => ({ path: `${SPREADSHEETS_DIR}/${tab.file}`, tab })),
  };
}
