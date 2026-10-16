/**
 * What the object delete dialog promises about timing and image files.
 *
 * Removing an object in the Compositor reaches the site on the next publish
 * or the next Objects save or upload, because both rebuild objects.csv from
 * the Compositor's data. Deleting from the repository leaves an image file in
 * place when another object uses it (`objectFileStems`).
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect } from "vitest";
import en from "~/i18n/locales/en/objects.json";
import es from "~/i18n/locales/es/objects.json";

const e = en as unknown as Record<string, string>;
const s = es as unknown as Record<string, string>;

describe("object delete dialog copy", () => {
  it.each(["delete_remove_compositor_effect", "delete_remove_compositor_effect_external"])(
    "%s names the Objects save or upload as a way the removal reaches the site",
    (key) => {
      expect(e[key]).toMatch(/next publish or your next save or upload/);
      expect(s[key]).toMatch(/hasta que publiques o hasta que guardes o subas algo en la página Objetos/);
    },
  );

  it("says shared image files stay when deleting from the repository", () => {
    expect(e.delete_remove_repo_effect).toMatch(/unless another object uses them/);
    expect(s.delete_remove_repo_effect).toMatch(/salvo los que use otro objeto/);
  });
});
