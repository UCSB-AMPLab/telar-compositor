// @vitest-environment jsdom

/**
 * The audio player keeps the one element WaveSurfer draws into when its
 * placement changes: a scene that moves its card below the player and back,
 * as a resized window does, must not leave the waveform, its seeking and its
 * clip region attached to an element that is no longer on the page.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const containers: HTMLElement[] = [];
const handlers = new Map<string, () => void>();
vi.mock("wavesurfer.js", () => ({
  default: {
    create: (options: { container: HTMLElement }) => {
      containers.push(options.container);
      return {
        on: (event: string, handler: () => void) => handlers.set(event, handler),
        destroy: () => {},
        setOptions: () => {},
        getCurrentTime: () => 0,
        getDuration: () => 60,
      };
    },
  },
}));
vi.mock("wavesurfer.js/dist/plugins/regions.js", () => ({
  default: { create: () => ({ on: () => {}, addRegion: () => ({ on: () => {}, setOptions: () => {} }) }) },
}));

import { AudioPlayer } from "~/components/features/editor/AudioPlayer";
import {
  AUDIO_CONTROLS_BUTTON_GAP,
  AUDIO_ELAPSED,
  audioControlsBelowBox,
  audioElapsedBelowAnchor,
  mediaCardBelow,
  stageRect,
  visitorLayout,
} from "~/lib/framing-stage";

afterEach(() => {
  cleanup();
  containers.length = 0;
  handlers.clear();
});

const placement = {
  wave: { x: 10, y: 60, w: 1200, h: 250 },
  controls: { x: 10, y: 314, w: 1200, h: 37 },
  elapsed: { right: 14, bottom: 290 },
  scale: 0.84,
};

describe("the audio player across a change of placement", () => {
  it("keeps WaveSurfer's container on the page, below the card and back beside it", async () => {
    const player = (p?: typeof placement) => (
      <div style={{ position: "relative" }}>
        <AudioPlayer audioUrl="https://example.org/a.mp3" onClipChange={() => {}} placement={p} />
      </div>
    );
    const view = render(player(placement));
    await waitFor(() => expect(containers).toHaveLength(1));
    await act(async () => handlers.get("ready")?.());
    const container = containers[0];
    expect(container.isConnected).toBe(true);

    view.rerender(player(undefined));
    expect(container.isConnected).toBe(true);
    view.rerender(player(placement));
    expect(container.isConnected).toBe(true);
    // One player throughout, drawing where it was created.
    expect(containers).toHaveLength(1);
    expect(view.getByTestId("audio-wave").contains(container)).toBe(true);
  });
});

describe("the saved clip's readout on the stage", () => {
  it("sits at the controls row's left edge, not where the playing time is", async () => {
    const view = render(
      <div style={{ position: "relative" }}>
        <AudioPlayer audioUrl="https://example.org/a.mp3" clipStart={10} clipEnd={30} onClipChange={() => {}} placement={placement} />
      </div>,
    );
    await waitFor(() => expect(handlers.has("ready")).toBe(true));
    act(() => handlers.get("ready")!());
    const readout = view.getByTestId("audio-saved-clip");
    expect(readout.textContent).toContain("0:10");
    expect(readout.style.left).toBe(`${placement.controls.x}px`);
    expect(readout.style.right).toBe("");
    expect(view.getByTestId("audio-controls").contains(readout)).toBe(false);
  });

  it("leaves room between the row's left edge, the centred buttons and the playing time: 1440×757, a 147px card", () => {
    const win = { w: 1440, h: 757 };
    const stage = stageRect({ w: 1240, h: 625 }, win)!;
    const s = stage.scale;
    const below = mediaCardBelow(visitorLayout(win.w, win.h), win.w, win.h, { kind: "audio", tallestContentHeight: 147 })!;
    const row = audioControlsBelowBox(win.w, win.h, below);
    const elapsed = audioElapsedBelowAnchor(win.w, win.h, below);
    // The widest the readout runs: "0:10 → 0:30" in 12px monospace and "✓ CLIP SAVED" in 10px spaced capitals.
    const readoutRight = row.x * s + 240;
    const buttonsLeft = (row.x + row.w / 2) * s - (3 * row.h + 2 * AUDIO_CONTROLS_BUTTON_GAP) * s / 2;
    // "0:00 / 0:30" at the pill's size, in stage pixels.
    const pillW = (11 * 0.6 * AUDIO_ELAPSED.fontSize + 2 * AUDIO_ELAPSED.paddingX) * s;
    const pillLeft = stage.w - elapsed.right * s - pillW;
    expect(readoutRight).toBeLessThan(buttonsLeft);
    expect(readoutRight).toBeLessThan(pillLeft);
  });
});
