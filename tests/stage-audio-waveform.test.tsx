// @vitest-environment jsdom

/**
 * An audio step's waveform on the framing stage is drawn at the height the
 * published page gives it (`audioWaveformBox`), in stage pixels, not the
 * player's own 80px. WaveSurfer is replaced by a recorder of the options the
 * player constructs and updates it with, which is where the drawn height is
 * decided.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { createOsdFake, withPoint } from "./helpers/osd-fake";

const osd = withPoint(createOsdFake());
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
}));

const created: Array<Record<string, unknown>> = [];
/** The player's handlers, so a test can raise WaveSurfer's `ready`. */
const handlers = new Map<string, () => void>();
const updated: Array<Record<string, unknown>> = [];
vi.mock("wavesurfer.js", () => ({
  default: {
    create: (options: Record<string, unknown>) => {
      created.push(options);
      return {
        on: (event: string, handler: () => void) => handlers.set(event, handler),
        destroy: () => {},
        setOptions: (next: Record<string, unknown>) => updated.push(next),
        getCurrentTime: () => 0,
        getDuration: () => 60,
      };
    },
  },
}));
vi.mock("wavesurfer.js/dist/plugins/regions.js", () => ({
  default: { create: () => ({ on: () => {}, addRegion: () => ({ on: () => {}, setOptions: () => {} }) }) },
}));

import { StoryStage } from "~/components/features/editor/StoryStage";
import {
  AUDIO_CONTROLS_BUTTON_GAP,
  AUDIO_CONTROL_ICON,
  AUDIO_ELAPSED,
  AUDIO_PLAY_ICON,
  audioElapsedBelowAnchor,
  audioBelowLayout,
  audioControlsBelowBox,
  audioWaveformBox,
  mediaCardBelow,
  stageRect,
  visitorLayout,
} from "~/lib/framing-stage";
import { unavailablePanelPreview } from "~/lib/panel-preview-config";

let restore: () => void = () => {};
beforeEach(() => {
  created.length = 0;
  updated.length = 0;
  handlers.clear();
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = ["clientWidth", "clientHeight"].map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 1240 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 768 });
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  restore = () => {
    for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
  };
});
afterEach(() => {
  cleanup();
  restore();
  vi.unstubAllGlobals();
});

function mountAudio() {
    const step = {
      id: 11, step_number: 1, question: "Listen", answer: "", alt_text: null, object_id: "song",
      x: null, y: null, zoom: null, page: null,
    };
    const song = { object_id: "song", title: "Song", thumbnail: null, image_available: false, source_url: "song.mp3", alt_text: null };
    const Stub = createRoutesStub([
      {
        path: "/",
        action: () => ({ ok: true }),
        Component: () => (
          <StoryStage
            storyTitle="Story"
            sidebar={null}
            titleCard={{
              story: { id: 1, title: "Story", subtitle: null, byline: null, show_sections: false },
              storyId: "s1", titleYText: null, subtitleYText: null, bylineYText: null,
              sectionCardCount: 0, sectionTitles: [], onToggleShowSections: () => {}, storyIds: [], canRenameId: false, onRenameId: () => {},
            }}
            onOpenLayer1={() => {}}
            stepIndex={1}
            step={step}
            isSectionCard={false}
            storySlug="s1"
            projectId={3}
            questionYText={null}
            answerYText={null}
            altTextYText={null}
            layer1={null}
            layer1ButtonLabelYText={null}
            onCreateLayer1={() => {}}
            viewer={{
              step, isStepZero: false, selectionKey: "id:11", stepDisplayNumber: 1, totalSteps: 1,
              objects: [song], manifestUrl: null, infoJsonUrl: null, isSelfHosted: false,
              siteBaseUrl: "https://example.org/site", onCapturePosition: () => {}, onChangeObject: () => {},
            }}
            panelPreview={Promise.resolve(unavailablePanelPreview())}
          />
        ),
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
}

describe("an audio step's waveform on the stage", () => {
  it("is drawn at the height of the framework's waveform box", async () => {
    mountAudio();
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    const stage = stageRect({ w: 1240, h: 768 }, { w: 1440, h: 900 })!;
    const box = audioWaveformBox(visitorLayout(1440, 900).mode, 1440, 900);
    const expected = Math.round(box.h * stage.scale);
    expect(expected).toBe(384);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].height).toBe(expected);

    // A window of another shape resizes the stage; the live waveform takes the new height.
    vi.stubGlobal("innerWidth", 1600);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    const wider = stageRect({ w: 1240, h: 768 }, { w: 1600, h: 900 })!;
    const next = Math.round(audioWaveformBox(visitorLayout(1600, 900).mode, 1600, 900).h * wider.scale);
    expect(next).not.toBe(expected);
    await waitFor(() => expect(updated.at(-1)).toEqual({ height: next }));
    expect(created).toHaveLength(1);
  });
});

describe("an audio scene with its card below the player", () => {
  it("places the waveform and the controls row each at its own box, at the stage's scale", async () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("innerHeight", 757);
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 652 });
    // The published rendering of the shown card, which decides the arrangement.
    Object.defineProperty(proto, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset?.testid === "scene-card-measure" ? 300 : 0;
      },
    });
    try {
      mountAudio();
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      await waitFor(() => expect(created).toHaveLength(1));
      await act(async () => handlers.get("ready")?.());

      const layout = visitorLayout(1440, 757);
      const below = mediaCardBelow(layout, 1440, 757, { kind: "audio", tallestContentHeight: 300 })!;
      const { wave } = audioBelowLayout(1440, 757, below);
      const row = audioControlsBelowBox(1440, 757, below);
      // The figures the framework gives at this window and card.
      expect(wave).toMatchObject({ y: 73, h: 298 });
      expect([row.y, row.y + row.h]).toEqual([375, 419]);

      const stage = stageRect({ w: 1240, h: 652 }, { w: 1440, h: 757 })!;
      const s = stage.scale;
      const waveEl = screen.getByTestId("audio-wave");
      expect(parseFloat(waveEl.style.top)).toBeCloseTo(wave.y * s, 6);
      expect(parseFloat(waveEl.style.height)).toBeCloseTo(wave.h * s, 6);
      expect(parseFloat(waveEl.style.left)).toBeCloseTo(wave.x * s, 6);
      expect(parseFloat(waveEl.style.width)).toBeCloseTo(wave.w * s, 6);
      expect(created[0].height).toBe(Math.round(wave.h * s));

      const rowEl = screen.getByTestId("audio-controls");
      expect(parseFloat(rowEl.style.top)).toBeCloseTo(row.y * s, 6);
      expect(parseFloat(rowEl.style.height)).toBeCloseTo(row.h * s, 6);
      expect(parseFloat(rowEl.style.gap)).toBeCloseTo(AUDIO_CONTROLS_BUTTON_GAP * s, 6);
      const play = within(rowEl).getByRole("button", { name: "media.play_aria" });
      expect(parseFloat(play.style.height)).toBeCloseTo(row.h * s, 6);
      expect(parseFloat(play.style.width)).toBeCloseTo(row.h * s, 6);

      // The framework's icon sizes and its readout, at the stage's scale.
      const size = (el: Element) => Number(el.querySelector("svg")!.getAttribute("width"));
      expect(size(play)).toBeCloseTo(AUDIO_PLAY_ICON * s, 6);
      expect(size(within(rowEl).getByRole("button", { name: "media.restart_clip_aria" }))).toBeCloseTo(AUDIO_CONTROL_ICON * s, 6);
      expect(size(within(rowEl).getByRole("button", { name: "media.mute_aria" }))).toBeCloseTo(AUDIO_CONTROL_ICON * s, 6);
      const readout = screen.getByTestId("audio-elapsed");
      const anchor = audioElapsedBelowAnchor(1440, 757, below);
      expect(anchor.right).toBe(16);
      expect(parseFloat(readout.style.right)).toBeCloseTo(anchor.right * s, 6);
      expect(parseFloat(readout.style.bottom)).toBeCloseTo(anchor.bottom * s, 6);
      expect(parseFloat(readout.style.fontSize)).toBeCloseTo(AUDIO_ELAPSED.fontSize * s, 6);
      expect(parseFloat(readout.style.paddingTop)).toBeCloseTo(AUDIO_ELAPSED.paddingY * s, 6);
      expect(parseFloat(readout.style.paddingLeft)).toBeCloseTo(AUDIO_ELAPSED.paddingX * s, 6);
      expect(parseFloat(readout.style.borderRadius)).toBeCloseTo(AUDIO_ELAPSED.radius * s, 6);
      expect(readout.textContent).toBe("0:00 / 1:00");
    } finally {
      if (saved) Object.defineProperty(proto, "offsetHeight", saved);
    }
  });
});
