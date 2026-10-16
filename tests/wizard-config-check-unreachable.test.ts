/**
 * The onboarding wizard says the site-configuration check could not be made,
 * and asks it again, where the server answers it unreachable. The
 * shell is too heavy to mount here, so this pins the wiring in its source.
 *
 * @version v1.5.5-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const onboardingDir = join(__dirname, "../app/components/features/onboarding");
const shell = readFileSync(join(onboardingDir, "WizardShell.tsx"), "utf8");
const note = readFileSync(join(onboardingDir, "ConfigCheckNote.tsx"), "utf8");
const skipped = readFileSync(join(onboardingDir, "useSkippedSettings.ts"), "utf8");

describe("the wizard's configuration check that could not be made (text check)", () => {
  it("retries the check while it is unreachable, and says so once settled", () => {
    expect(shell).toMatch(/useRetryWhileUnreachable\(configCheckData, submitConfigCheck\)/);
    expect(shell).toMatch(/const submitConfigCheck = \(\) => \{[\s\S]{0,300}?intent: "check-site-config"/);
    expect(shell).toMatch(/configCheckNoteState\(configCheckData, configCheckFetcher\.state !== "idle"\)/);
    expect(note).toMatch(/if \(isUnreachableAnswer\(answer\)\) return "unreachable"/);
    expect(note).toMatch(/unreachable: "site_config\.check_failed"/);
  });

  it("passes the first-build note only for a created site whose build was started", () => {
    expect(shell).toMatch(/\{\.\.\.doneScreenSite\(selectedRepo\)\}/);
    expect(skipped).toMatch(/buildStarted: Boolean\(created && repo\?\.bornClean\)/);
  });
});
