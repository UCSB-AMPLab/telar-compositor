// @vitest-environment jsdom
/**
 * The clip range the viewer column shows under a video step.
 *
 * Start time, arrow and end time are one sentence, so they are one catalogue
 * string: a language that words a range differently — or capitalises the label
 * where English does not — needs the whole readout, not a label with two
 * numbers assembled around it in the JSX.
 *
 * The Spanish case is the one that would pass a key-echoing assertion while
 * being wrong on screen, so it is asserted as rendered text: `Clip` is
 * capitalised there, matching the strings it sits beside, and the English `clip`
 * is not.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import type { CatalogueLanguage } from "./helpers/catalogue-translator";

/** The locale the next render reads; each test sets it before rendering. */
let language: CatalogueLanguage = "en";

vi.mock("openseadragon", async () => {
  const { osd } = await import("./helpers/viewer-column-harness");
  return { default: osd.ctor };
});
vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  return {
    useTranslation: () => ({
      t: catalogueT("editor", language),
      i18n: { language },
    }),
  };
});
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: () => null }));

import {
  buildColumn,
  installFetch,
  renderColumn,
  step,
  videoObject,
} from "./helpers/viewer-column-harness";

const FILM = videoObject("film", "Film");

beforeEach(() => {
  cleanup();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  language = "en";
});

/** The column on a video step with a clip set, in the current language. */
async function renderClip(clipStart: string | null, clipEnd: string | null) {
  return renderColumn(buildColumn, {
    step: step({ object_id: "film", clip_start: clipStart, clip_end: clipEnd }),
    isStepZero: false,
    selectionKey: "step-1",
    objects: [FILM],
  });
}

describe("viewer column — the clip range readout", () => {
  it("renders start, arrow and end as one English sentence", async () => {
    await renderClip("12", "95");

    expect(screen.queryByText("clip 0:12 → 1:35")).not.toBeNull();
  });

  it("renders the Spanish range with its own capitalisation", async () => {
    language = "es";
    await renderClip("12", "95");

    expect(screen.queryByText("Clip 0:12 → 1:35")).not.toBeNull();
  });

  it("fills a missing end with zero rather than dropping half the range", async () => {
    await renderClip("30", null);

    expect(screen.queryByText("clip 0:30 → 0:00")).not.toBeNull();
  });

  it("shows the no-clip string when neither end is set", async () => {
    await renderClip(null, null);

    expect(screen.queryByText("No clip set")).not.toBeNull();
  });
});
