// @vitest-environment jsdom
/**
 * SiteConfigConfirmation: each refusal the fix can return reaches its own
 * message, and the "why" line shows only under an item that still needs fixing.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SiteConfigConfirmation } from "~/components/features/onboarding/SiteConfigConfirmation";

afterEach(cleanup);

function renderCard(overrides: Partial<React.ComponentProps<typeof SiteConfigConfirmation>> = {}) {
  return render(
    <SiteConfigConfirmation
      sheetsEnabled={false}
      pagesNotEnabled={false}
      urlMismatch={null}
      error={null}
      errorMessage={null}
      repoFullName="owner/repo"
      installationId={7}
      onConfirmed={() => {}}
      onSkip={() => {}}
      isSubmitting={false}
      {...overrides}
    />,
  );
}

describe("SiteConfigConfirmation: a refusal says what is wrong", () => {
  const cases: Array<[string, string, string]> = [
    ["sheets_not_disableable", "site_config.error_sheets_not_disableable_title", "site_config.error_sheets_not_disableable"],
    ["config_not_found", "site_config.error_config_not_found_title", "site_config.error_config_not_found"],
    ["pages_failed", "site_config.error_pages_failed_title", "site_config.error_pages_failed"],
    ["not_found", "site_config.error_not_found_title", "site_config.error_not_found"],
    ["pages_private_repo", "site_config.error_private_repo_title", "site_config.error_private_repo"],
    ["pages_permission_denied", "site_config.error_pages_permission_title", "site_config.error_pages_permission"],
    ["something_unmapped", "site_config.error_generic_title", "site_config.error_generic"],
  ];

  for (const [code, title, body] of cases) {
    it(`${code} reaches its own message`, () => {
      renderCard({ error: code, sheetsEnabled: true });
      expect(screen.getByText(title)).toBeDefined();
      expect(screen.getByText(body)).toBeDefined();
      if (code !== "something_unmapped") expect(screen.queryByText("site_config.error_generic")).toBeNull();
    });
  }
});

describe("SiteConfigConfirmation: why lines", () => {
  it("shows the why under items that need fixing", () => {
    renderCard({ sheetsEnabled: true, pagesNotEnabled: true });
    expect(screen.getByText("site_config.sheets_why")).toBeDefined();
    expect(screen.getByText("site_config.pages_why")).toBeDefined();
    expect(screen.getByText("site_config.url_pending_why")).toBeDefined();
  });

  it("omits the why under items that passed", () => {
    renderCard({ urlMismatch: { pagesUrl: "https://a.github.io/r", configUrl: "https://b.github.io" } });
    expect(screen.queryByText("site_config.sheets_why")).toBeNull();
    expect(screen.queryByText("site_config.pages_why")).toBeNull();
    expect(screen.getByText("site_config.url_why")).toBeDefined();
  });

  it("shows no why when everything passed", () => {
    renderCard();
    for (const key of ["sheets_why", "pages_why", "url_why", "url_pending_why"]) {
      expect(screen.queryByText(`site_config.${key}`)).toBeNull();
    }
  });
});
