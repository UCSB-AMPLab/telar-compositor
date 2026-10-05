// @vitest-environment jsdom
/**
 * The story editor finds a step's object as the site does.
 *
 * A step naming `film` shows, on the published site, the object written
 * `film.jpg` (the framework strips an image extension from both before it
 * matches them), so the editor's viewer shows that object for it, and a
 * self-hosted `codex.jpg` is read from its tiles under `codex`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

vi.mock("openseadragon", async () => {
  const { osd } = await import("./helpers/viewer-column-harness");
  return { default: osd.ctor };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

import {
  buildColumn,
  installFetch,
  osd,
  renderColumn,
  selfHostedObject,
  serveObject,
  SITE_BASE,
  step,
  videoObject,
} from "./helpers/viewer-column-harness";

beforeEach(() => {
  cleanup();
  osd.reset();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a step's object in the story editor", () => {
  it("shows the video written film.jpg for a step naming film", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "film" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: [videoObject("film.jpg", "Film")],
    });
    expect(document.querySelector("iframe")).not.toBeNull();
    expect(osd.instances).toHaveLength(0);
  });

  it("reads a self-hosted codex.jpg from its tiles under codex", async () => {
    serveObject("codex", 1);
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex.jpg" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: [selfHostedObject("codex.jpg", "Codex")],
    });
    await waitFor(() => expect(osd.instances.length).toBeGreaterThan(0));
    expect(String(osd.last().tileSource)).toContain(`${SITE_BASE}/iiif/codex/p1`);
  });
});

describe("the object picker opened from a step", () => {
  it("marks as current the object codex.jpg that a step naming codex shows", async () => {
    serveObject("codex", 1);
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: [selfHostedObject("codex.jpg", "Codex"), selfHostedObject("atlas", "Atlas")],
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("viewer.change_object"));
    });
    const cards = [...document.querySelectorAll("button.border-2")] as HTMLButtonElement[];
    const card = (title: string) => cards.find((b) => b.textContent?.includes(title));
    expect(card("Codex")?.className).toContain("bg-anil/10");
    expect(card("Atlas")?.className).not.toContain("bg-anil/10");
  });
});
