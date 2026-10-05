/**
 * What a sync or restore action answers for a file it could not read,
 * by what the file is: a sheet is named by its file name, the
 * ignore list by what it is, and any other file by its path in the
 * repository, so no page calls a Markdown file or `_config.yml` a sheet.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { syncFailure } from "~/lib/sync-failure.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";

describe("syncFailure for a file that could not be read", () => {
  it("names a sheet by its file name", () => {
    expect(syncFailure("apply-full-sync", new SheetUnreadableError("telar-content/spreadsheets/story-one.csv"), "apply_failed"))
      .toEqual({ ok: false, intent: "apply-full-sync", error: "sheet_unreadable", sheet: "story-one.csv" });
  });

  it("names the ignore list by what it is", () => {
    expect(syncFailure("ignore-orphans", new SheetUnreadableError(".compositor-ignored"), "ignore_failed"))
      .toEqual({ ok: false, intent: "ignore-orphans", error: "ignore_list_unreadable" });
  });

  it.each(["telar-content/texts/stories/x/panel.md", "_config.yml"])("names %s by its path", (path) => {
    expect(syncFailure("restore-orphan-drafts", new SheetUnreadableError(path), "restore_failed"))
      .toEqual({ ok: false, intent: "restore-orphan-drafts", error: "file_unreadable", file: path });
  });

  it("keeps the path on the error", () => {
    expect(new SheetUnreadableError("_config.yml").path).toBe("_config.yml");
  });
});
