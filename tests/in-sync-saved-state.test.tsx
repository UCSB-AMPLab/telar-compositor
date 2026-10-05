// @vitest-environment jsdom
/**
 * The saved-state size row of the in-sync popover, rendered through the REAL
 * translation resources rather than a stubbed `t`.
 *
 * A mocked translator would pass whatever the component asked for straight
 * back, so it could not show that the key exists, that it is under the
 * namespace the component reads, or that the size reaches it interpolated. The
 * locale cases are the point of the row: the separator belongs to the reader's
 * language, so the same byte count reads "1.3 MB" in English and "1,3 MB" in
 * Spanish. The Spanish string itself is drafted and reviewed separately, so
 * Spanish falls back to the English sentence for now — the figure inside it is
 * the locale's own either way.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import {
  InSyncPopover,
  type InSyncPayload,
} from "~/components/features/site-status/popovers/InSyncPopover";
import enPopover from "~/i18n/locales/en/popover.json";
import esPopover from "~/i18n/locales/es/popover.json";

const ONE_MIB = 1_048_576;

const IN_SYNC: InSyncPayload = {
  last_published_at: "2026-05-20T10:00:00Z",
  head_sha: "abc1234def5678",
  last_synced_at: "2026-05-20T10:05:00Z",
  commitMessage: "Publish stories",
  blobBytes: null,
};

/** The pill's own empty payload while the in-sync body is still loading. */
const LOADING: InSyncPayload = {
  last_published_at: null,
  head_sha: null,
  last_synced_at: null,
  commitMessage: null,
  blobBytes: null,
};

async function withRealResources(language: "en" | "es") {
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: "en",
    ns: ["popover"],
    defaultNS: "popover",
    resources: {
      en: { popover: enPopover },
      es: { popover: esPopover },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

async function renderInSync(payload: InSyncPayload, language: "en" | "es" = "en") {
  const i18n = await withRealResources(language);
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <InSyncPopover payload={payload} pagesUrl="https://example.org" />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe("the in-sync popover states the saved state's size above one mebibyte", () => {
  it("renders the row for one byte above the mark, in English", async () => {
    const { container } = await renderInSync({ ...IN_SYNC, blobBytes: ONE_MIB + 1 });

    expect(container.textContent).toContain("This project's saved state is 1.0 MB");
    expect(container.textContent).toContain("it can no longer be published");
  });

  it("renders the same figure with the Spanish separator", async () => {
    const { container } = await renderInSync({ ...IN_SYNC, blobBytes: 1_300_000 }, "es");

    expect(container.textContent).toContain("1,3 MB");
    expect(container.textContent).not.toContain("1.3 MB");
  });

  it("renders the English figure with a decimal point", async () => {
    const { container } = await renderInSync({ ...IN_SYNC, blobBytes: 1_300_000 });

    expect(container.textContent).toContain("1.3 MB");
  });

  it("renders nothing at exactly one mebibyte", async () => {
    const { container } = await renderInSync({ ...IN_SYNC, blobBytes: ONE_MIB });

    expect(container.textContent).not.toContain("saved state");
    expect(container.textContent).not.toContain("MB");
  });

  it("renders nothing for a row with no blob, and nothing while the payload loads", async () => {
    const absent = await renderInSync(IN_SYNC);
    expect(absent.container.textContent).not.toContain("saved state");

    const loading = await renderInSync(LOADING);
    expect(loading.container.textContent).not.toContain("saved state");
  });

  it("keeps the three rows the popover already carries", async () => {
    const { container } = await renderInSync({ ...IN_SYNC, blobBytes: ONE_MIB + 1 });

    expect(container.textContent).toContain(enPopover.in_sync.title);
    expect(container.textContent).toContain("abc1234");
    expect(container.textContent).toContain("Publish stories");
  });
});
