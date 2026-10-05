// @vitest-environment jsdom

/**
 * The framing stage finds a step's object as the published site does.
 *
 * A step naming `song` shows, on the site, the audio object written
 * `song.jpg` (the framework strips an image extension from the object's id and
 * from the step's value before it matches them), so the stage lays out that
 * step as an audio scene and draws its waveform where the page draws it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { audioWaveformBox, stageRect, visitorLayout } from "~/lib/framing-stage";
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
    const song = { object_id: "song.jpg", title: "Song", thumbnail: null, image_available: false, source_url: "song.mp3", alt_text: null };
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

describe("a step naming song, with the audio object written song.jpg", () => {
  it("is laid out as an audio scene, its waveform at the framework's height", async () => {
    mountAudio();
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    const stage = stageRect({ w: 1240, h: 768 }, { w: 1440, h: 900 })!;
    const box = audioWaveformBox(visitorLayout(1440, 900).mode, 1440, 900);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].height).toBe(Math.round(box.h * stage.scale));
    // The scene's cards are measured as the published page measures a media
    // scene's, which the stage does only for a step it reads as media.
    expect(screen.queryAllByTestId("scene-card-measure").length).toBeGreaterThan(0);
  });
});
