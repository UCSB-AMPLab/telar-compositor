/**
 * StageGuideTags — the short name tags that say what each guide on the
 * framing stage is.
 *
 * Four guides need explaining: the card's dashed ceiling, the frame, the
 * centre target and the whole stage. Each has a tag fixed to the guide it
 * names, drawn in that guide's own colour so the two read as one thing, and
 * pressing a tag shows its full sentence; only one sentence is open at a
 * time, so they never pile up over the image. The tags are buttons the tag
 * itself discloses (`aria-expanded`), and Escape closes the open sentence and
 * puts focus back on its tag, but only while focus is on that tag or nowhere,
 * so a field or panel that owns the key keeps it. Clicking or dragging the
 * image leaves a sentence open.
 *
 * Where each tag and the open sentence go is the stage chrome's decision
 * (`layoutStageChrome`); a sentence the chrome has no room for is not drawn,
 * and its tag does not report itself expanded. Whether a tag is open is the
 * caller's `openTag`, not what was drawn: pressing the open tag closes it, and
 * Escape is heard while one is open, drawn or not. In a compact region the
 * tags drop their names and show their icon alone, the name kept as the
 * button's label and title.
 * The frame's sentence opens by itself on a first visit (`useFirstVisitGuide`).
 *
 * @version v1.5.2-beta
 */

import { Fragment, useEffect, useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { STAGE_Z } from "~/components/features/editor/FramingStage";
import type { Box } from "~/lib/framing-stage";
import {
  GUIDE_TAG_PART,
  GUIDE_TEXT_PART,
  ceilingTagInside,
  sentenceStandsFree,
  stageTagInCorner,
  type ChromeLayout,
  type GuideTag,
  type Size,
} from "~/lib/stage-chrome";
import type { ChromeMeasure } from "~/hooks/use-chrome-sizes";
import { useFirstVisitGuide } from "~/hooks/use-first-visit-guide";

const GUIDES: GuideTag[] = ["ceiling", "frame", "target", "stage"];

/** A tag's and its sentence's colours: the colour of the line it names. */
const TONE = {
  charcoal: { face: "bg-charcoal text-cream", icon: "opacity-70" },
  deep: { face: "bg-charcoal-deep text-cream", icon: "opacity-70" },
  frame: { face: "bg-white/96 text-charcoal", icon: "opacity-60" },
} as const;

interface Look {
  tone: keyof typeof TONE;
  tag: string;
  text: string;
  shadow?: boolean;
}

/**
 * How a tag is drawn where the chrome put it: its corners are the ones away
 * from the line it is fixed to, and all four where it stands off that line.
 * A sentence in its fallback place, standing free of its tag, rounds all four
 * (`sentenceStandsFree`).
 */
function lookOf(kind: GuideTag, tag: Box, ceiling: Box | null, stage: Size, frameOnStroke: boolean): Look {
  switch (kind) {
    case "ceiling":
      return ceilingTagInside(tag, ceiling)
        ? { tone: "charcoal", tag: "rounded-[0_0_4px_0]", text: "rounded-[0_4px_4px_4px]" }
        : { tone: "charcoal", tag: "rounded-[4px_4px_0_0]", text: "rounded-[0_4px_4px_4px]" };
    case "frame":
      return { tone: "frame", tag: frameOnStroke ? "rounded-[0_0_4px_0]" : "rounded-[4px]", text: "rounded-[0_4px_4px_4px]", shadow: true };
    case "target":
      return { tone: "frame", tag: "rounded-[4px]", text: "rounded-[4px]" };
    case "stage":
      return stageTagInCorner(tag, stage)
        ? { tone: "deep", tag: "rounded-[0_4px_0_0]", text: "rounded-[0_4px_0_0]" }
        : { tone: "deep", tag: "rounded-[4px]", text: "rounded-[4px]" };
  }
}

/** Each tag's name and sentence. */
function useGuideWords(): Record<GuideTag, { name: string; text: string }> {
  const { t } = useTranslation("editor");
  return {
    ceiling: { name: t("stage.guides.ceiling"), text: t("stage.guides.ceiling_text") },
    frame: { name: t("stage.guides.frame"), text: t("stage.guides.frame_text") },
    target: { name: t("stage.guides.target"), text: t("stage.guides.target_text") },
    stage: { name: t("stage.guides.stage"), text: t("stage.guides.stage_text") },
  };
}

/** The corners of a tag's sentence: all four rounded where it stands free of its tag, else the look's. */
function textCornersOf(text: Box | undefined, tag: Box, look: Look): string {
  return sentenceStandsFree(text, tag) ? "rounded-[4px]" : look.text;
}

/** One guide's tag button and, where the chrome drew it, its open sentence. */
function GuideTagWithText({
  kind,
  tag,
  text,
  look,
  name,
  sentence,
  textId,
  open,
  compact,
  tagRef,
  textRef,
  onPress,
}: {
  kind: GuideTag;
  tag: Box;
  text: Box | undefined;
  look: Look;
  name: string;
  sentence: string;
  textId: string;
  /** Whether this tag is the caller's `openTag`. */
  open: boolean;
  compact: boolean;
  tagRef: (el: HTMLButtonElement | null) => void;
  textRef: (el: HTMLElement | null) => void;
  onPress: (kind: GuideTag, wasOpen: boolean) => void;
}) {
  const { t } = useTranslation("editor");
  const textCorners = textCornersOf(text, tag, look);
  const tone = TONE[look.tone];
  return (
    <Fragment>
      <button
        ref={tagRef}
        type="button"
        data-testid={`guide-tag-${kind}`}
        aria-expanded={open && !!text}
        aria-controls={text ? textId : undefined}
        aria-label={compact ? name : t("stage.guides.more_aria", { name })}
        title={compact ? name : undefined}
        onClick={() => onPress(kind, open)}
        className={`pointer-events-auto absolute inline-flex items-center whitespace-nowrap font-heading text-[13px] font-semibold uppercase leading-normal tracking-[0.05em] hover:opacity-90 ${tone.face} ${look.tag} ${
          compact ? "h-8 w-8 justify-center" : "gap-[7px] px-3 py-[7px]"
        }`}
        style={{ left: tag.x, top: tag.y, zIndex: STAGE_Z.controls }}
      >
        {!compact && name}
        <Info aria-hidden="true" className={`h-[15px] w-[15px] shrink-0 ${compact ? "" : tone.icon}`} />
      </button>
      {/* Its padding and line are the layout's `SENTENCE_TEXT`, which reads its height at another width from them. */}
      {text && (
        <div
          ref={textRef}
          id={textId}
          data-testid={`guide-text-${kind}`}
          className={`pointer-events-auto absolute px-[13px] py-[10px] font-body text-[15px] font-normal leading-[1.45] ${tone.face} ${textCorners}${
            look.shadow ? " shadow-[0_4px_6px_-1px_rgba(0,0,0,0.15)]" : ""
          }`}
          style={{ left: text.x, top: text.y, width: text.w, zIndex: STAGE_Z.controls }}
        >
          {sentence}
        </div>
      )}
    </Fragment>
  );
}

export function StageGuideTags({
  layout,
  ceiling,
  stage,
  frameTagOnStroke,
  compact,
  measure,
  openTag,
  onPress,
  onEscape,
  onFirstVisit,
}: {
  layout: ChromeLayout;
  /** The ceiling drawn beside a side card, in stage pixels, where there is one. */
  ceiling: Box | null;
  stage: Size;
  /** Whether the frame's tag hangs from the frame's top stroke; under the top bar it stands off it. */
  frameTagOnStroke: boolean;
  compact: boolean;
  measure: ChromeMeasure;
  /**
   * The tag whose sentence is open, null for none. It stays set when the
   * chrome has no room to draw the sentence; the tag still closes on a press.
   */
  openTag: GuideTag | null;
  /** A tag was pressed; `wasOpen` is whether it was `openTag`. */
  onPress: (kind: GuideTag, wasOpen: boolean) => void;
  /** Escape closed the open sentence, `kind` being `openTag`. */
  onEscape: (kind: GuideTag) => void;
  /** The frame's tag is on the stage for the first time in this page load. */
  onFirstVisit: () => void;
}) {
  const { t } = useTranslation("editor");
  const words = useGuideWords();
  const idBase = useId();
  const buttons = useRef<Partial<Record<GuideTag, HTMLButtonElement | null>>>({});
  const tagRefs = useMemo(
    () =>
      Object.fromEntries(
        GUIDES.map((kind) => {
          const measureTag = measure(GUIDE_TAG_PART[kind]);
          return [
            kind,
            (el: HTMLButtonElement | null) => {
              buttons.current[kind] = el;
              measureTag(el);
            },
          ];
        }),
      ) as Record<GuideTag, (el: HTMLButtonElement | null) => void>,
    [measure],
  );
  useFirstVisitGuide(!!layout.tagFrame, onFirstVisit);

  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  useEffect(() => {
    if (!openTag) return;
    const open = openTag;
    function closeOnEscape(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const tag = buttons.current[open];
      const active = document.activeElement;
      if (active && active !== document.body && active !== tag) return;
      e.preventDefault();
      onEscapeRef.current(open);
      tag?.focus();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [openTag]);

  return (
    <>
      {GUIDES.map((kind) => {
        const tag = layout[GUIDE_TAG_PART[kind]];
        if (!tag) return null;
        const text = layout[GUIDE_TEXT_PART[kind]];
        return (
          <GuideTagWithText
            key={kind}
            kind={kind}
            tag={tag}
            text={text}
            look={lookOf(kind, tag, ceiling, stage, frameTagOnStroke)}
            name={words[kind].name}
            sentence={words[kind].text}
            textId={`${idBase}-${kind}`}
            open={openTag === kind}
            compact={compact}
            tagRef={tagRefs[kind]}
            textRef={measure(GUIDE_TEXT_PART[kind])}
            onPress={onPress}
          />
        );
      })}
    </>
  );
}
