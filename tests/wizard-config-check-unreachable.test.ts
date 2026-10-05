/**
 * The onboarding wizard says the site-configuration check could not be made,
 * and asks it again, where the server answers it unreachable. The
 * shell is too heavy to mount here, so this pins the wiring in its source.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const shell = readFileSync(join(__dirname, "../app/components/features/onboarding/WizardShell.tsx"), "utf8");

describe("the wizard's configuration check that could not be made (text check)", () => {
  it("retries the check while it is unreachable, and says so once settled", () => {
    expect(shell).toMatch(/useRetryWhileUnreachable\(configCheckData, \(\) => \{[\s\S]{0,300}?intent: "check-site-config"/);
    expect(shell).toMatch(/<ConfigCheckNote failed=\{isUnreachableAnswer\(configCheckData\) && configCheckFetcher\.state === "idle"\} \/>/);
    expect(shell).toMatch(/if \(!failed\) return null;[\s\S]{0,300}site_config\.check_failed/);
  });
});
