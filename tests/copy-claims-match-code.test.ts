/**
 * Strings that state what the Compositor does, checked against the code that
 * does it: who can publish, what a pending invitation shows, which names the
 * author sees, what a failed language patch names, what deleting a glossary
 * term leaves behind, and the instruction for folded columns while the
 * Compositor has no control for them.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect } from "vitest";
import enCollaboration from "~/i18n/locales/en/collaboration.json";
import esCollaboration from "~/i18n/locales/es/collaboration.json";
import enTeam from "~/i18n/locales/en/team.json";
import esTeam from "~/i18n/locales/es/team.json";
import enAccount from "~/i18n/locales/en/account.json";
import esAccount from "~/i18n/locales/es/account.json";
import enGlossary from "~/i18n/locales/en/glossary.json";
import esGlossary from "~/i18n/locales/es/glossary.json";
import enConfig from "~/i18n/locales/en/config.json";
import esConfig from "~/i18n/locales/es/config.json";
import enCommon from "~/i18n/locales/en/common.json";
import esCommon from "~/i18n/locales/es/common.json";
import { isPublishingRole } from "~/lib/publishing-roles";

describe("welcome and publish-freeze copy", () => {
  it("rests on collaborators and instructors being able to publish", () => {
    expect(isPublishingRole("collaborator")).toBe(true);
    expect(isPublishingRole("instructor")).toBe(true);
  });

  it("does not tell a new collaborator their edits wait for the convenor", () => {
    expect(enCollaboration.welcome_added_body).not.toMatch(/private/i);
    expect(esCollaboration.welcome_added_body).not.toMatch(/no se publican hasta/i);
    expect(enCollaboration.welcome_added_body).toContain("anyone on the team publishes");
  });

  it("names the publisher and the site, not the owner and a story", () => {
    for (const body of [enCollaboration.publish_freeze_body_collaborator, esCollaboration.publish_freeze_body_collaborator]) {
      expect(body).toContain("{{name}}");
    }
    expect(enCollaboration.publish_freeze_body_collaborator).not.toMatch(/owner|story/i);
    expect(esCollaboration.publish_freeze_body_collaborator).not.toMatch(/propietario|historia/i);
  });
});

describe("pending invitation label", () => {
  it("states no expiry it does not know", () => {
    expect(enTeam.pending_label).not.toMatch(/\d/);
    expect(esTeam.pending_label).not.toMatch(/\d/);
  });
});

describe("language patch failure", () => {
  it("names the field and page the author sees", () => {
    expect(enAccount.preferences.create_site_lang_patch_failed_body).not.toContain("telar_language");
    expect(esAccount.preferences.create_site_lang_patch_failed_body).not.toContain("telar_language");
    expect(enAccount.preferences.create_site_lang_patch_failed_body).toContain(enConfig.title);
    expect(enAccount.preferences.create_site_lang_patch_failed_body).toContain(enConfig.sections.site_settings.field_language);
    expect(esAccount.preferences.create_site_lang_patch_failed_body).toContain(esConfig.title);
    expect(esAccount.preferences.create_site_lang_patch_failed_body).toContain(esConfig.sections.site_settings.field_language);
  });
});

describe("glossary term deletion", () => {
  it("leaves the question to the dialog title and keeps the consequence", () => {
    expect(enGlossary.delete_term_confirm).not.toContain("Delete this term?");
    expect(esGlossary.delete_term_confirm).not.toContain("¿Eliminar este término?");
    expect(enGlossary.delete_term_confirm).toContain("broken links");
  });
});

describe("folded columns", () => {
  it("keeps its instruction until the Compositor has a control for it", () => {
    expect(enCommon.sheet_warnings.folded_columns).toContain("remove the others from the sheet");
    expect(esCommon.sheet_warnings.folded_columns).toContain("quites las demás de la hoja");
  });
});
