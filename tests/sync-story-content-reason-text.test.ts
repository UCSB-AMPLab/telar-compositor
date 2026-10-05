/**
 * The sentence the sync dialog writes for each reason a story cannot be read,
 * rendered from the real English and Spanish catalogues: a translation that
 * drops a placeholder leaves a value out of the sentence and fails here, which
 * the dialog test's key-echoing mock cannot see.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { createInstance } from "i18next";
import type { TFunction } from "i18next";
import enDashboard from "~/i18n/locales/en/dashboard.json";
import esDashboard from "~/i18n/locales/es/dashboard.json";
import { reasonText } from "~/components/features/dashboard/SyncStoryContentBlock";
import type { UnreadableReason } from "~/lib/story-canonical";

const SAMPLES: Array<[UnreadableReason, string[]]> = [
  [{ code: "step_missing", row: 7 }, ["7"]],
  [{ code: "step_not_plain", step: "dos", row: 7 }, ["dos", "7"]],
  [{ code: "step_too_precise", step: "1.0000000000000001", row: 7 }, ["1.0000000000000001", "7"]],
  [{ code: "step_repeated", step: "4", earlier: "4.0" }, ["4", "4.0"]],
  [{ code: "layer_number_repeated", row: 7, layer: 3 }, ["7", "3"]],
  [{ code: "layer_reference_not_plain", reference: "./panel.md" }, ["./panel.md"]],
  [{ code: "layer_reference_directory", reference: "Notas/panel" }, ["Notas/panel"]],
  [{ code: "layer_reference_non_ascii", reference: "Café.md" }, ["Café.md"]],
  [{ code: "columns_collide", column: "question", headers: ["Question", "pregunta"] }, ["question", "Question", "pregunta"]],
];

async function translator(lng: "en" | "es"): Promise<TFunction<"dashboard">> {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: false,
    ns: ["dashboard"],
    defaultNS: "dashboard",
    resources: { en: { dashboard: enDashboard }, es: { dashboard: esDashboard } },
    interpolation: { escapeValue: false },
  });
  return i18n.getFixedT(lng, "dashboard") as TFunction<"dashboard">;
}

describe.each(["en", "es"] as const)("reason sentences in %s", (lng) => {
  it.each(SAMPLES)("%j carries every one of its values", async (reason, values) => {
    const text = reasonText(await translator(lng), reason);
    expect(text).toBeTypeOf("string");
    expect(text).not.toContain("content_reason_");
    for (const value of values) expect(text, value).toContain(value);
  });

  it("the general code has no sentence of its own", async () => {
    expect(reasonText(await translator(lng), { code: "files_unreadable" })).toBeNull();
  });
});
