/**
 * Prepare's reads of the site's own files: one read per path per prepare, the
 * byte-order mark taken off for a caller that parses and kept for one that
 * writes the bytes back, as the sheet repair does.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it, vi } from "vitest";

import { siteFileReads, UpgradeFileUnreadableError } from "~/lib/upgrade-reads.server";
import type { FileAtRef } from "~/lib/github.server";

const BOM = "﻿";

describe("siteFileReads", () => {
  it("answers a file with its mark for the repair and without it for a parser, from one read", async () => {
    const readAtHead = vi.fn(async (): Promise<FileAtRef> => ({ status: "ok", content: `${BOM}a,b\n` }));
    const site = siteFileReads(readAtHead);
    expect(await site.readKeepingMark("s.csv")).toBe(`${BOM}a,b\n`);
    expect(await site.read("s.csv")).toBe("a,b\n");
    expect(await site.readKeepingMark("s.csv")).toBe(`${BOM}a,b\n`);
    expect(readAtHead).toHaveBeenCalledTimes(1);
  });

  it("answers null for an absent file and stops by name for a failed one", async () => {
    const site = siteFileReads(async (path): Promise<FileAtRef> => (path === "gone.csv" ? { status: "absent" } : { status: "error" }));
    expect(await site.readKeepingMark("gone.csv")).toBeNull();
    await expect(site.readKeepingMark("bad.csv")).rejects.toEqual(new UpgradeFileUnreadableError("bad.csv"));
  });

  it("puts the mark back on a file that had one after a parser's read", async () => {
    const site = siteFileReads(async (): Promise<FileAtRef> => ({ status: "ok", content: `${BOM}x: 1\n` }));
    await site.read("_config.yml");
    const files = new Map([["_config.yml", "x: 2\n"]]);
    site.restoreMarks(files);
    expect(files.get("_config.yml")).toBe(`${BOM}x: 2\n`);
  });
});
