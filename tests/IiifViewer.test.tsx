// @vitest-environment jsdom

/**
 * Regression guard for the IIIF viewer "blank until interaction" bug.
 *
 * Root cause (confirmed on staging 2026-05-26 with a controlled WebGL upload test):
 * OpenSeadragon 6 defaults to the WebGL drawer, which calls texImage2D() on each
 * IIIF tile. Tiles load as cross-origin <img> without crossOrigin, so texImage2D
 * throws SecurityError ("The image element contains cross-origin data") on every
 * tile -> "Error creating texture in WebGL" -> OSD falls back to the Canvas2D
 * drawer. That failed-WebGL->canvas transition leaves the viewer blank until a
 * redraw fires (autoResize, eventually; user interaction in the worst case).
 *
 * Fix: construct OSD with drawer: "canvas" so it renders deterministically via the
 * Canvas2D drawer from the start. This pins that choice — if someone drops the
 * option (reverting to the WebGL default), this test fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

const osdCtor = vi.fn((_opts: Record<string, unknown>) => ({ destroy: vi.fn() }));
vi.mock("openseadragon", () => ({ default: osdCtor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { IiifViewer } from "~/components/features/objects/IiifViewer";

describe("IiifViewer — drawer config (blank-until-interaction regression)", () => {
  beforeEach(() => {
    cleanup();
    osdCtor.mockClear();
  });

  it("constructs OpenSeadragon with the Canvas2D drawer, not WebGL", async () => {
    render(
      <IiifViewer
        manifestUrl={null}
        infoJsonUrl="https://example.org/iiif/abc/info.json"
        isSelfHosted={false}
      />,
    );

    await waitFor(() => expect(osdCtor).toHaveBeenCalled());

    const opts = osdCtor.mock.calls[0][0];
    // The fix: canvas drawer (cross-origin-safe, deterministic). Default would be WebGL.
    expect(opts.drawer).toBe("canvas");
    // Sanity: it wired the tile source through.
    expect(opts.tileSources).toBe("https://example.org/iiif/abc/info.json");
  });
});
