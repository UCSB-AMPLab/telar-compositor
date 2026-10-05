// @vitest-environment jsdom
/**
 * A sheet warning in the publish checks, rendered by the review's own
 * component through the real i18next and the real catalogue: the sentence is
 * the one the import's review gives, naming the sheet and the row.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { createInstance, type i18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

import { ValidationChecks } from "~/components/features/publish/ValidationChecks";
import type { ValidationResult } from "~/lib/publish.server";
import enPublish from "~/i18n/locales/en/publish.json";
import enCommon from "~/i18n/locales/en/common.json";

let instance: i18n;

beforeAll(async () => {
  instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: ["publish", "common"],
    defaultNS: "publish",
    resources: { en: { publish: enPublish, common: enCommon } },
    interpolation: { escapeValue: false },
  });
});

afterEach(cleanup);

describe("a sheet warning among the checks", () => {
  it("reads as the import's sentence, naming the sheet and the row", () => {
    const validation: ValidationResult = {
      blockers: [],
      warnings: [
        {
          code: "sheet_warning",
          message: "sheet_warning",
          entityId: "objects.csv/0",
          sheetWarning: { code: "ragged_row", sheet: "objects.csv", row: { label: "loom" } },
        },
      ],
    };
    render(
      <I18nextProvider i18n={instance}>
        <MemoryRouter>
          <ValidationChecks validation={validation} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    expect(screen.getByText(/Row "loom" in the sheet "objects.csv" has values in columns with no heading/)).toBeTruthy();
  });
});
