/**
 * The Pages route says a scan could not be made, with a button to run it
 * again, where an unreachable answer stands in for an empty list.
 * The page is too heavy to mount here, so this pins the wiring in its source.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const page = readFileSync(join(__dirname, "../app/routes/_app.pages.tsx"), "utf8");

describe("the Pages scan that could not be made (text check)", () => {
  it("reads an unreachable scan on an empty list as a failure, and says so with a retry", () => {
    expect(page).toMatch(/return pageCount === 0 && isUnreachableAnswer\(data\);/);
    expect(page).toMatch(/<ScanNotMadeNote\s+failed=\{scanFailed\}\s+onRetry=\{\(\) => repoScanFetcher\.submit\(\{ intent: "scan-repo-pages" \}/);
    expect(page).toMatch(/if \(!failed\) return null;[\s\S]{0,300}t\("scan_not_made"\)[\s\S]{0,200}t\("scan_retry"\)/);
  });
});
