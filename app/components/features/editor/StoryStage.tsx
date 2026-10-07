/**
 * StoryStage — what the story editor shows beside its step list.
 *
 * A step is shown on the framing stage: the published page for a window
 * shaped like the author's, scaled to fit (`FramingStage`). The viewer is the
 * stage's image, confined to the region the page frames into; the step card
 * floats on it at the visitor's size, in the site's theme (`StepCard`); the
 * answer's line count sits beside the card, the guide tags say what each
 * guide is while the guides show (`StageGuideTags`), one sentence open at a
 * time and none once another step is selected, and the alt-text chip sits on
 * the image (`AltTextChip`). The step's open layer panels stand on the stage in a
 * panel layer of their own, above the chrome (`StagePanels`). The title card
 * and section cards frame nothing: each is drawn on the stage as the
 * published page draws it, edited in place (`CardStage`, `TitleCardView`,
 * `SectionCardView`), and the title card's ID and section-list switch stand
 * in a bar above it (`TitleCardSettings`).
 *
 * Where there is no Y.Text to type into, a field saves through the route's
 * action (`useRouteFieldSave`), so a loader read begun before the save never
 * delivers its older text to the field. A layer's content without a Y.Text
 * has one owner for the project and story (`useLayerContentDrafts`), which
 * keeps its draft, its timer and the answers to its saves across every
 * editor that shows it.
 *
 * The site's theme comes from the preview configuration the loader streams:
 * its colours and fonts over the shipped theme's, and the shipped theme's web
 * fonts where it names one.
 *
 * @version v1.5.2-beta
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { EditorShell } from "~/components/features/editor/EditorShell";
import { CardStage, FramingStage, STAGE_Z, VisitorLayer, stageBox } from "~/components/features/editor/FramingStage";
import { StepCard, type StepTextField } from "~/components/features/editor/StepCard";
import { AltTextChip } from "~/components/features/editor/AltTextChip";
import { ViewerColumn } from "~/components/features/editor/ViewerColumn";
import { LayerPanel, type LayerFieldSaves, type LayerTextField } from "~/components/features/editor/LayerPanel";
import { StagePanels, type StagePanelLayer } from "~/components/features/editor/StagePanels";
import type { PanelLevel, PanelOpenRequest } from "~/hooks/use-layer-panels";
import { TitleCardSettings, TitleCardView, type TitleCardData } from "~/components/features/editor/TitleCardView";
import { SectionCardView } from "~/components/features/editor/SectionCardView";
import { AnswerBudgetCounter } from "~/components/ui/InlineTextArea";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useRouteFieldSave, type FieldSaveOptions } from "~/hooks/use-route-field-save";
import { useLayerContentDrafts, type LayerContentDrafts } from "~/hooks/use-layer-content-drafts";
import type { StageGeometry } from "~/hooks/use-stage-geometry";
import { cardBox, ceilingBox, regionOf, type Box, type MediaBelow, type MediaKind } from "~/lib/framing-stage";
import { frameInRegion } from "~/lib/authoring-frame";
import { chromeIsCompact, frameTagOnStroke, layoutStageChrome, type ChromeInput, type ChromeSizes, type GuideTag } from "~/lib/stage-chrome";
import { StageGuideTags } from "~/components/features/editor/StageGuideTags";
import { rememberFrameGuideDismissed } from "~/hooks/use-first-visit-guide";
import { useChromeSizes } from "~/hooks/use-chrome-sizes";
import { SceneMeasures, sceneBelow, useSceneHeights, type SceneStepText } from "~/components/features/editor/SceneCards";
import { glossaryEntryKindsFromDoc, glossaryTermsFromDoc } from "~/lib/glossary-links";
import { NO_GLOSSARY_KINDS, type GlossaryKinds } from "~/lib/glossary-kinds";
import { useGlossaryKinds } from "~/components/features/glossary/GlossaryKindSelect";
import type { MathDelimiter } from "~/components/ui/markdown-editor/panelMath";
import type { GlossaryContext } from "~/lib/answer-preview";
import { detectMediaType, extractVideoId } from "~/lib/media-type";
import { useVideoAspect } from "~/hooks/use-video-aspect";
import { playerBottomBelow } from "~/components/features/editor/StageMedia";
import { resolveStepObject } from "~/lib/object-id";
import { STAGE_THEME_COLOURS, THEME_TOKENS } from "~/lib/theme-tokens";
import { themeFontHref } from "~/lib/theme-fonts";
import { nextStamp } from "~/components/ui/target-saves";
import {
  unavailablePanelPreview,
  type PanelPreviewConfig,
  type PanelPreviewSource,
} from "~/lib/panel-preview-config";

type RouteFieldSave = ReturnType<typeof useRouteFieldSave>;

type ViewerProps = Omit<ComponentProps<typeof ViewerColumn>, "stage" | "visitorLayer" | "stageOverlay">;

/** The step's layer panels, as the route holds them, and what they do. */
export interface StoryPanels {
  layer1: StagePanelLayer | null;
  layer2: StagePanelLayer | null;
  level: PanelLevel;
  request: PanelOpenRequest;
  onClose: (layerNumber: 1 | 2) => void;
  onDelete: (layerNumber: 1 | 2) => void;
  onCreateLayer2: () => void;
  /** Opens layer 2 from layer 1's button for it. */
  onOpenLayer2: (opener: HTMLElement) => void;
  deleteTooltip?: string;
  objects: ComponentProps<typeof LayerPanel>["objects"];
  actionUrl: string;
  /** The site's `telar_language`, whose default labels head an untitled panel. */
  siteLang?: string | null;
  onOpenDoc?: (id: string) => void;
  /** Asks a layer's panel to highlight its first glossary link once rendered (the glossary's "Used in" jump). */
  highlight?: { id: number; layerNumber: 1 | 2 } | null;
  /** The panel has rendered and highlighted, or had no link to highlight. */
  onHighlighted?: (id: number) => void;
}

/** The step the stage shows. */
export interface StageStep {
  id: number;
  step_number: number;
  question: string | null;
  answer: string | null;
  alt_text: string | null;
  object_id: string | null;
}

interface StoryStageProps {
  storyTitle: string;
  sidebar: ReactNode;
  /** The title card, shown for step 0. */
  titleCard: TitleCardData;
  /** 0 for the title card, then the step's place in the list. */
  stepIndex: number;
  step: StageStep | null;
  isSectionCard: boolean;
  storySlug: string;
  questionYText: Y.Text | null;
  answerYText: Y.Text | null;
  altTextYText: Y.Text | null;
  /** The step's first panel, whose button the card shows. */
  layer1: Pick<StagePanelLayer, "id" | "button_label" | "writeUnsaved"> | null;
  layer1ButtonLabelYText: Y.Text | null;
  onCreateLayer1: () => void;
  /** Opens the first panel, as the step list's row for it does, from the button pressed. */
  onOpenLayer1: (opener: HTMLElement) => void;
  /** The viewer's props, as the route derives them. */
  viewer: ViewerProps;
  /** The step's layer panels. */
  panels?: StoryPanels;
  panelPreview?: PanelPreviewSource;
  /** The kinds the site offers, which a glossary callout in a panel shows; none until they arrive. */
  glossaryKinds?: GlossaryKinds | Promise<GlossaryKinds>;
  /** When the loader read the data the step's texts come from; absent for the server's first render. */
  readStamp?: number;
  /** The project the story belongs to, which a failed draft is kept under. */
  projectId: number;
  /**
   * The steps of the scene the step belongs to, itself included: the run of
   * steps sharing its object (`sceneRun`), whose tallest card decides a video
   * or audio scene's arrangement.
   */
  sceneSteps?: readonly SceneStepText[];
}

/**
 * The step's texts as the fields may be given them, and the saves that
 * decide it. A save is confirmed on target-saves' counter when its answer
 * arrives; a text from a loader read stamped before that is older than the
 * save and is held back, and the field keeps what it was last given. The
 * router aborts most such reads, but not one that finishes before the read
 * the save started, so the order is kept here rather than trusted to it.
 */
function useFreshStepText(readStamp: number | undefined, save: RouteFieldSave) {
  const confirmedAt = useRef(new Map<string, number>());
  const given = useRef(new Map<string, string>());
  const fresh = useCallback(
    (target: string, value: string) => {
      const saved = confirmedAt.current.get(target);
      if (saved !== undefined && readStamp !== undefined && readStamp < saved && given.current.has(target)) {
        return given.current.get(target)!;
      }
      given.current.set(target, value);
      return value;
    },
    [readStamp],
  );
  const saveFor = useCallback(
    (target: string, fields: Record<string, string>, options?: FieldSaveOptions) =>
      save(fields, options).then((answeredAt) => {
        confirmedAt.current.set(target, answeredAt ?? nextStamp());
        return answeredAt;
      }),
    [save],
  );
  return { fresh, saveFor };
}

/** The site's preview configuration once the loader's promise settles. */
function usePreviewConfig(source: PanelPreviewSource | undefined): PanelPreviewConfig | undefined {
  const [config, setConfig] = useState<PanelPreviewConfig | undefined>(undefined);
  useEffect(() => {
    let current = true;
    Promise.resolve(source ?? unavailablePanelPreview())
      .catch(() => unavailablePanelPreview())
      .then((next) => {
        if (current) setConfig(next);
      });
    return () => {
      current = false;
    };
  }, [source]);
  return config;
}

/**
 * The visitor layer's theme: the shipped theme's colours and fonts, the
 * site's own file over them where it was read.
 */
function themeStyleOf(config: PanelPreviewConfig | undefined): CSSProperties {
  const id = config?.themeId ?? "";
  const colours = STAGE_THEME_COLOURS[id] ?? STAGE_THEME_COLOURS.trama;
  const fonts = THEME_TOKENS[id] ?? THEME_TOKENS.trama;
  const shipped: Record<string, string> = {
    "--color-heading": colours.heading,
    "--color-body": colours.body,
    "--color-link": colours.link,
    "--color-button-bg": colours.buttonBg,
    "--color-button-text": colours.buttonText,
    "--color-panel-layer1-bg": colours.panelLayer1Bg,
    "--color-panel-layer1-text": colours.panelLayer1Text,
    "--color-panel-layer2-bg": colours.panelLayer2Bg,
    "--color-panel-layer2-text": colours.panelLayer2Text,
    "--font-headings": fonts.headingFont,
    "--font-body": fonts.bodyFont,
  };
  // The preview configuration names the body font for the panels it styles.
  const { "--panel-body-font": bodyFont, ...site } = config?.theme ?? {};
  return { ...shipped, ...site, ...(bodyFont ? { "--font-body": bodyFont } : {}) } as CSSProperties;
}

/** The project's glossary terms and each one's stored kind, read again whenever the glossary changes. */
function useGlossaryTerms(ydoc: Y.Doc | null) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!ydoc) return;
    const glossary = ydoc.getArray("glossary");
    const onGlossaryChange = () => setVersion((v) => v + 1);
    glossary.observeDeep(onGlossaryChange);
    return () => glossary.unobserveDeep(onGlossaryChange);
  }, [ydoc]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ terms: glossaryTermsFromDoc(ydoc), entryKinds: glossaryEntryKindsFromDoc(ydoc) }), [ydoc, version]);
}

/** The site's baseurl, which its glossary links carry: the path of the site's address. */
function baseUrlOf(siteBaseUrl: string | null): string {
  if (!siteBaseUrl) return "";
  try {
    return new URL(siteBaseUrl).pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

/**
 * The answer's lines against the budget, where the stage's chrome puts it:
 * hanging from the ceiling's bottom edge beside a side card, so its top
 * corners are square there.
 */
function StageLineCounter({
  box,
  underCeiling,
  answer,
  glossary,
  measureRef,
}: {
  box: Box;
  underCeiling: boolean;
  answer: string;
  glossary: GlossaryContext;
  measureRef: (el: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={measureRef}
      data-testid="stage-line-counter"
      className={`stage-line-counter absolute ${underCeiling ? "rounded-[0_0_6px_6px]" : "rounded-lg"} bg-black/60 px-3 py-1.5`}
      style={{ left: box.x, top: box.y, width: box.w, zIndex: STAGE_Z.controls }}
    >
      <AnswerBudgetCounter text={answer} glossary={glossary} />
    </div>
  );
}

/**
 * The chrome's layout for a step on the stage: the framework's region, frame,
 * card and ceiling in stage pixels, and what the step shows. With the card
 * below its player no ceiling is drawn: the published card never reaches one
 * there, since a card that tall keeps the scene beside the player.
 */
export function stageChromeFor(
  geometry: StageGeometry,
  opts: {
    media: boolean;
    below: MediaBelow | null;
    publishedHeight: number | undefined;
    image: boolean;
    guidesShown: boolean;
    /** The guide tag whose sentence is open, if any. */
    openTag?: GuideTag | null;
    sizes: ChromeSizes;
  },
) {
  const { layout, window: win, stage } = geometry;
  const s = stage.scale;
  const { media, below } = opts;
  const region = stageBox(regionOf(layout, win.w, win.h, { media, below }), s);
  const f = frameInRegion(region);
  const ceiling = below ? null : ceilingBox(layout, win.w, win.h, { media });
  const input: ChromeInput = {
    stage: { w: stage.w, h: stage.h },
    region,
    frame: { x: f.x, y: f.y, w: f.width, h: f.height },
    card: stageBox(cardBox(layout, win.w, win.h, { media, below, contentHeight: opts.publishedHeight }), s),
    cardPlacement: layout.cardPlacement,
    below: below !== null && layout.mode === "horizontal",
    ceiling: ceiling && stageBox(ceiling, s),
    show: {
      viewfinder: opts.image,
      tags: opts.image && opts.guidesShown,
      ceilingTag: opts.guidesShown && ceiling !== null,
      open: opts.openTag ?? null,
      zoom: !media,
      bar: true,
      chip: !media,
      counter: true,
    },
    sizes: opts.sizes,
  };
  const chrome = layoutStageChrome(input);
  return {
    layout: chrome,
    compact: chromeIsCompact(region.w),
    stage: input.stage,
    ceiling: input.ceiling,
    frameTagOnStroke: frameTagOnStroke(chrome.tagFrame, input.frame),
  };
}

/** What the step's object is, and whether the step shows a video or audio plate. */
function stepMedia(
  objects: StoryStageProps["viewer"]["objects"],
  objectId: string | null | undefined,
  frameworkVersion: string | null | undefined,
) {
  const object = resolveStepObject(objects, objectId, frameworkVersion);
  const mediaType = detectMediaType(object?.source_url, object?.object_id);
  const media = mediaType !== "iiif" && mediaType !== "text-only";
  const kind: MediaKind | null = mediaType === "audio" ? "audio" : media ? "video" : null;
  return { mediaType, media, kind, ...embeddedVideo(mediaType, object?.source_url) };
}

/** The hosted provider a video object is embedded from, and its id there. */
function embeddedVideo(mediaType: ReturnType<typeof detectMediaType>, sourceUrl: string | null | undefined) {
  const provider = mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive" ? mediaType : null;
  const videoId = provider && sourceUrl ? extractVideoId(provider, sourceUrl) : null;
  return { provider, videoId };
}

/** A step field's key in the editor's selection, from the step's selection key. */
function fieldTargetOf(selectionKey: string) {
  return (field: string) => `${selectionKey}:${field}`;
}

/** Saves a step's text field through the route, for a step with a database id. */
function stepFieldSave(text: ReturnType<typeof useFreshStepText>, target: (field: string) => string, stepId: number) {
  return (field: StepTextField | "alt_text", value: string) =>
    stepId > 0
      ? text.saveFor(target(field), { intent: "save-step-field", stepId: String(stepId), field, value })
      : Promise.reject(new Error("unsaved step"));
}

/** Where an unsaved edit to each field is kept for recovery; none for a step or panel not yet saved. */
function recoveryKeysOf(projectId: StoryStageProps["projectId"], stepId: number, layer1: StoryStageProps["layer1"]) {
  const stepKey = (field: string) => (stepId > 0 ? `project:${projectId}/step:${stepId}/${field}` : undefined);
  return {
    question: stepKey("question"),
    answer: stepKey("answer"),
    altText: stepKey("alt_text"),
    buttonLabel: layer1 && layer1.id > 0 ? `project:${projectId}/layer:${layer1.id}/button_label` : undefined,
  };
}

/** The scene with the shown step's text as its fields hold it now, first where the scene does not hold it. */
function withShownStep(sceneSteps: readonly SceneStepText[], shownText: (current: SceneStepText | undefined) => SceneStepText) {
  if (!sceneSteps.some((s) => s.current)) return [shownText(undefined), ...sceneSteps];
  return sceneSteps.map((s) => (s.current ? shownText(s) : s));
}

/** The step with its three text fields as the stage's saves last left them. */
function freshStep(step: StageStep, text: ReturnType<typeof useFreshStepText>, target: (field: string) => string) {
  return {
    ...step,
    question: text.fresh(target("question"), step.question ?? ""),
    answer: text.fresh(target("answer"), step.answer ?? ""),
    alt_text: text.fresh(target("alt_text"), step.alt_text ?? ""),
  };
}

/** The step's first layer with its button label as the stage's saves last left it. */
function freshLayer1(layer1: StoryStageProps["layer1"], text: ReturnType<typeof useFreshStepText>, target: (field: string) => string) {
  return layer1 && { ...layer1, button_label: text.fresh(target("layer1-button"), layer1.button_label ?? "") };
}

/** The delimiters the published cards read their text with, where the preview config is available. */
function delimitersOf(config: PanelPreviewConfig | undefined) {
  return config?.available ? config.delimiters : undefined;
}

/** Whether the word count sits flush under the ceiling, rather than somewhere else on the stage. */
function counterUnderCeiling(counter: Box, ceiling: Box | null): boolean {
  return !!ceiling && Math.abs(counter.y - (ceiling.y + ceiling.h)) < 1e-6;
}

function FramedStep({
  step,
  stepIndex,
  storySlug,
  questionYText,
  answerYText,
  altTextYText,
  layer1,
  layer1ButtonLabelYText,
  onCreateLayer1,
  onOpenLayer1,
  viewer,
  panels,
  panelPreview,
  glossaryKinds = NO_GLOSSARY_KINDS,
  config,
  text,
  contentDrafts,
  readStamp,
  projectId,
  sceneSteps = [],
}: Omit<StoryStageProps, "storyTitle" | "sidebar" | "titleCard" | "isSectionCard" | "step" | "readStamp"> & {
  step: StageStep;
  config: PanelPreviewConfig | undefined;
  /** The stage's saves, which outlive this step's fields, and the texts they allow. */
  text: ReturnType<typeof useFreshStepText>;
  /** The stage's owner of layer content without a Y.Text. */
  contentDrafts: LayerContentDrafts;
  readStamp?: number;
}) {
  const { t } = useTranslation("editor");
  const { ydoc } = useCollaborationContext();
  const { terms, entryKinds } = useGlossaryTerms(ydoc);
  const kinds = useGlossaryKinds(glossaryKinds);
  const glossary = useMemo(
    () => ({ terms, entryKinds, kinds, baseUrl: baseUrlOf(viewer.siteBaseUrl) }),
    [terms, entryKinds, kinds, viewer.siteBaseUrl],
  );
  const [answer, setAnswer] = useState(step.answer ?? "");
  const [question, setQuestion] = useState<string | null>(null);
  const [buttonLabel, setButtonLabel] = useState<string | null>(null);
  const [guidesShown, setGuidesShown] = useState(true);
  // The open guide sentence belongs to the step it was opened on: another step starts with none.
  const [guideOpen, setGuideOpen] = useState<{ key: string; tag: GuideTag | null }>({ key: viewer.selectionKey, tag: null });
  const openTag = guideOpen.key === viewer.selectionKey ? guideOpen.tag : null;
  const showGuide = (tag: GuideTag | null) => setGuideOpen({ key: viewer.selectionKey, tag });
  // Closing the frame's sentence, or opening another over it, dismisses the first visit's.
  const leaveGuide = (next: GuideTag | null) => {
    if (openTag === "frame" && next !== "frame") rememberFrameGuideDismissed();
    showGuide(next);
  };

  const { mediaType, media, kind, provider, videoId } = stepMedia(viewer.objects, step.object_id, viewer.frameworkVersion);
  const videoAspect = useVideoAspect(provider, videoId);
  const sceneHeights = useSceneHeights();
  const chromeSizes = useChromeSizes();
  // The scene as the published cards would show it, the shown step with the
  // text its fields hold now.
  const shownText = (current: SceneStepText | undefined): SceneStepText => ({
    key: current?.key ?? `shown:${viewer.selectionKey}`,
    current: true,
    question: question ?? shownStep.question,
    answer,
    buttonLabel: shownLayer1 ? (buttonLabel ?? shownLayer1.button_label) : null,
  });
  const fieldKeyPrefix = `step-${storySlug}-${step.id}`;
  const saveErrorMessage = t("stage.save_failed");

  const target = fieldTargetOf(viewer.selectionKey);
  const recoveryKeys = recoveryKeysOf(projectId, step.id, layer1);
  const saveStepField = stepFieldSave(text, target, step.id);

  const writeUnsaved = layer1?.writeUnsaved;
  const saveButtonLabel = (value: string) =>
    writeUnsaved
      ? Promise.resolve(writeUnsaved("button_label", value))
      : layer1 && layer1.id > 0
      ? text.saveFor(target("layer1-button"), {
          intent: "autosave-layer",
          layerId: String(layer1.id),
          field: "button_label",
          value,
        })
      : Promise.reject(new Error("unsaved layer"));

  const shownStep = freshStep(step, text, target);
  const shownLayer1 = freshLayer1(layer1, text, target);

  // The panels' fields save through the stage's own save, as the card's do,
  // so a field finished as its panel closes is still sent and settled.
  const layerTarget = (layer: StagePanelLayer, field: LayerTextField) => `layer:${layer.key}:${field}`;
  const layerFields: LayerFieldSaves = {
    save: (layer, field, value, options) =>
      layer.id > 0
        ? text.saveFor(layerTarget(layer, field), { intent: "autosave-layer", layerId: String(layer.id), field, value }, options)
        : Promise.reject(new Error("unsaved layer")),
    fresh: (layer, field, value) => text.fresh(layerTarget(layer, field), value),
    recoveryKey: (layer, field) => (layer.id > 0 ? `project:${projectId}/layer:${layer.id}/${field}` : undefined),
    saveErrorMessage,
  };
  const scene = withShownStep(sceneSteps, shownText);
  const shownKey = scene.find((s) => s.current)!.key;

  return (
    <FramingStage>
      {(geometry) => {
        const below = sceneBelow(geometry, kind, scene, sceneHeights, videoAspect.shape?.aspect ?? null);
        const chrome = {
          ...stageChromeFor(geometry, {
            media,
            below,
            publishedHeight: sceneHeights.byKey[shownKey],
            image: mediaType === "iiif",
            guidesShown,
            openTag,
            sizes: chromeSizes.sizes,
          }),
          measure: chromeSizes.measure,
        };
        const at = chrome.layout;
        return (
        <>
          <ViewerColumn
            {...viewer}
            stage={geometry}
            chrome={chrome}
            mediaBelow={below}
            videoAspect={videoAspect.shape}
            onVideoAspect={videoAspect.learn}
            onGuidesChange={setGuidesShown}
            visitorLayer={
              <VisitorLayer geometry={geometry} themeStyle={themeStyleOf(config)}>
                {kind && (
                  <SceneMeasures
                    geometry={geometry}
                    scene={scene}
                    heights={sceneHeights}
                    glossary={glossary}
                    delimiters={delimitersOf(config)}
                    defaultLabel={t("layer.default_label_1")}
                  />
                )}
                <StepCard
                  below={below}
                  publishedHeight={sceneHeights.byKey[shownKey]}
                  playerBottom={playerBottomBelow(geometry.window, below, kind, videoAspect.shape)}
                  geometry={geometry}
                  media={media}
                  step={shownStep}
                  target={viewer.selectionKey}
                  fieldKeyPrefix={fieldKeyPrefix}
                  questionYText={questionYText}
                  answerYText={answerYText}
                  onSaveField={saveStepField}
                  layer1={shownLayer1}
                  buttonLabelYText={layer1ButtonLabelYText}
                  onSaveButtonLabel={saveButtonLabel}
                  onCreateLayer={onCreateLayer1}
                  onOpenLayer={onOpenLayer1}
                  glossary={glossary}
                  delimiters={delimitersOf(config)}
                  saveErrorMessage={saveErrorMessage}
                  onAnswerChange={setAnswer}
                  onQuestionChange={setQuestion}
                  onButtonLabelChange={setButtonLabel}
                  recoveryKeys={recoveryKeys}
                />
              </VisitorLayer>
            }
            stageOverlay={({ isImage }) =>
              isImage && at.chip && (
                <AltTextChip
                  key={viewer.selectionKey}
                  target={target("alt_text")}
                  recoveryKey={recoveryKeys.altText}
                  saveErrorMessage={saveErrorMessage}
                  initialValue={shownStep.alt_text}
                  yText={altTextYText}
                  fieldKey={`${fieldKeyPrefix}-alt_text`}
                  withHelp={stepIndex === 1}
                  onSave={(value) => saveStepField("alt_text", value)}
                  at={at.chip}
                  compact={chrome.compact}
                  measureRef={chromeSizes.measure("chip")}
                />
              )
            }
          />
          {panels && (
            <StagePanels
              geometry={geometry}
              themeStyle={themeStyleOf(config)}
              selectionKey={viewer.selectionKey}
              layer1={panels.layer1}
              layer2={panels.layer2}
              level={panels.level}
              request={panels.request}
              onClose={panels.onClose}
              onDelete={panels.onDelete}
              deleteTooltip={panels.deleteTooltip}
              renderPanel={(layer, { covered, headingRef }) => (
                <LayerPanel
                  layer={layer}
                  headingRef={headingRef}
                  siteLang={panels.siteLang}
                  dismissed={covered}
                  layer2={panels.layer2}
                  onCreateLayer2={panels.onCreateLayer2}
                  onOpenLayer2={panels.onOpenLayer2}
                  fields={layerFields}
                  contentDrafts={contentDrafts}
                  readStamp={readStamp}
                  glossary={glossary}
                  previewConfig={config}
                  highlight={panels.highlight?.layerNumber === layer.layer_number ? panels.highlight.id : null}
                  onHighlighted={panels.onHighlighted}
                  objects={panels.objects}
                  siteBaseUrl={viewer.siteBaseUrl}
                  frameworkVersion={viewer.frameworkVersion}
                  panelPreview={panelPreview}
                  actionUrl={panels.actionUrl}
                  onOpenDoc={panels.onOpenDoc}
                />
              )}
            />
          )}
          {at.counter && (
            <StageLineCounter
              box={at.counter}
              underCeiling={counterUnderCeiling(at.counter, chrome.ceiling)}
              answer={answer}
              glossary={glossary}
              measureRef={chromeSizes.measure("counter")}
            />
          )}
          <StageGuideTags
            layout={at}
            ceiling={chrome.ceiling}
            stage={chrome.stage}
            frameTagOnStroke={chrome.frameTagOnStroke}
            compact={chrome.compact}
            measure={chromeSizes.measure}
            openTag={openTag}
            onPress={(tag, wasOpen) => leaveGuide(wasOpen ? null : tag)}
            onEscape={() => leaveGuide(null)}
            onFirstVisit={() => showGuide("frame")}
          />
        </>
        );
      }}
    </FramingStage>
  );
}

/** A section card on the stage, its fields saved as the step card's are. */
function SectionStage({
  step,
  storySlug,
  selectionKey,
  questionYText,
  answerYText,
  text,
  projectId,
  themeStyle,
  siteBaseUrl,
  delimiters,
}: {
  step: StageStep;
  storySlug: string;
  selectionKey: string;
  questionYText: Y.Text | null;
  answerYText: Y.Text | null;
  text: ReturnType<typeof useFreshStepText>;
  projectId: number;
  themeStyle: CSSProperties;
  siteBaseUrl: string | null;
  delimiters?: MathDelimiter[];
}) {
  const { t } = useTranslation("editor");
  const { ydoc } = useCollaborationContext();
  const { terms } = useGlossaryTerms(ydoc);
  const glossary = useMemo(() => ({ terms, baseUrl: baseUrlOf(siteBaseUrl) }), [terms, siteBaseUrl]);
  const target = fieldTargetOf(selectionKey);
  const shown = {
    id: step.id,
    question: text.fresh(target("question"), step.question ?? ""),
    answer: text.fresh(target("answer"), step.answer ?? ""),
  };
  return (
    <CardStage themeStyle={themeStyle}>
      {() => (
        <SectionCardView
          step={shown}
          target={selectionKey}
          fieldKeyPrefix={`step-${storySlug}-${step.id}`}
          questionYText={questionYText}
          answerYText={answerYText}
          onSaveField={stepFieldSave(text, target, step.id)}
          saveErrorMessage={t("stage.save_failed")}
          recoveryKeys={recoveryKeysOf(projectId, step.id, null)}
          glossary={glossary}
          delimiters={delimiters}
        />
      )}
    </CardStage>
  );
}

export function StoryStage({ storyTitle, sidebar, titleCard, isSectionCard, ...rest }: StoryStageProps) {
  const config = usePreviewConfig(rest.panelPreview);
  // Owned here, not by the step: a field finished just before the author
  // selects the title card or another step is still sent and settled.
  const save = useRouteFieldSave();
  const text = useFreshStepText(rest.readStamp, save);
  const { t } = useTranslation("editor");
  const { ydoc } = useCollaborationContext();
  // A layer's content without a Y.Text, owned for the project and story so
  // a draft outlives the panel, the step and the editor showing it.
  const contentDrafts = useLayerContentDrafts({
    scope: { projectId: rest.projectId, storyKey: rest.storySlug, actionUrl: rest.panels?.actionUrl },
    send: (layerId, fields, options) => text.saveFor(`layer-content:${layerId}`, fields, options),
    errorMessage: t("stage.save_failed"),
    ydoc,
  });
  const { step, stepIndex } = rest;
  const fontHref = themeFontHref(config?.themeId);

  let stage: ReactNode = null;
  if (stepIndex === 0) {
    stage = (
      <CardStage settings={<TitleCardSettings {...titleCard} />} themeStyle={themeStyleOf(config)}>
        {(geometry) => <TitleCardView {...titleCard} layoutMode={geometry.layout.mode} />}
      </CardStage>
    );
  } else if (step && isSectionCard) {
    stage = (
      <SectionStage
        step={step}
        storySlug={rest.storySlug}
        selectionKey={rest.viewer.selectionKey}
        questionYText={rest.questionYText}
        answerYText={rest.answerYText}
        text={text}
        projectId={rest.projectId}
        themeStyle={themeStyleOf(config)}
        siteBaseUrl={rest.viewer.siteBaseUrl}
        delimiters={config?.available ? config.delimiters : undefined}
      />
    );
  } else if (step) {
    stage = <FramedStep {...rest} step={step} config={config} text={text} contentDrafts={contentDrafts} readStamp={rest.readStamp} />;
  }

  return (
    <>
      {fontHref && <link rel="stylesheet" href={fontHref} />}
      <EditorShell storyTitle={storyTitle} sidebar={sidebar} stage={stage} framing={stage !== null && stepIndex > 0 && !isSectionCard} />
    </>
  );
}
