/**
 * What the Upgrade page's copy claims about the upgrade, read from the
 * locale files: nothing in the review stage says the upgrade leaves content
 * and settings alone, the up-to-date line and the success line announce
 * neither an upgrade nor a running build they did not see and the sheet
 * report speaks of the changes as made, since it appears only after the
 * commit landed.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect } from "vitest";
import en from "~/i18n/locales/en/upgrade.json";
import es from "~/i18n/locales/es/upgrade.json";

describe("upgrade copy", () => {
  it("does not promise that content or settings stay as they are", () => {
    for (const key of ["changesDescription", "hint_whatIsUpgrade"] as const) {
      expect(en[key]).not.toMatch(/not your content|not be affected|does not change your content/i);
      expect(es[key]).not.toMatch(/no tu contenido|no se verán afectados|no cambia tu contenido/i);
    }
  });

  it("does not say a build is running on the line for a finished or absent upgrade", () => {
    expect(en.upgradeSuccessDetail).not.toMatch(/running/i);
    expect(es.upgradeSuccessDetail).not.toMatch(/proceso/i);
    expect(en.upToDate).not.toMatch(/upgraded|running/i);
  });

  it("does not claim in the answers introduction that the sheets are unchanged", () => {
    expect(en.answersIntro).not.toMatch(/doesn't change your sheets/);
    expect(es.answersIntro).not.toMatch(/no cambia tus hojas/);
    expect(en).not.toHaveProperty("answersSheetsUnchanged");
    expect(es).not.toHaveProperty("answersSheetsUnchanged");
  });

  it("speaks of the sheet repairs in the past tense", () => {
    expect(en.repairDropped).toMatch(/deleted/);
    expect(en.repairHeaderRowDeleted).toMatch(/deleted/);
    expect(es.repairDropped).toMatch(/se borró/);
  });
});
