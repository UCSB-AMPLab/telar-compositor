/**
 * The Config page says a theme refresh could not be made, and leaves the
 * refresh button as the retry. The page is too heavy to mount here,
 * so this pins the wiring in its source.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const page = readFileSync(join(__dirname, "../app/routes/_app.config.tsx"), "utf8");

describe("the theme refresh that failed (text check)", () => {
  it("says so for any failed refresh except a refusal, once it has settled", () => {
    expect(page).toMatch(/return !refreshing && answer\?\.ok === false && answer\.intent === "refresh-themes" && answer\.error !== "forbidden";/);
    expect(page).toMatch(/<ThemeRefreshNote failed=\{themeRefreshFailed\} \/>/);
    expect(page).toMatch(/if \(!failed\) return null;[\s\S]{0,200}refresh_themes_failed/);
  });
});
