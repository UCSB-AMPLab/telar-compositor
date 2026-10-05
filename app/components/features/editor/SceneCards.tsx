/**
 * SceneCards — how a video or audio scene is arranged on the stage: its cards
 * beside the player, or below it where that gives the player more room.
 *
 * The published page decides a scene's arrangement from its tallest card
 * (`mediaCardBelow` in framing-stage.ts), and applies it to every step of the
 * scene. Every card of the scene, the shown step's included, is laid out here,
 * hidden, in the visitor layer: the same `.text-card` markup at the card's
 * width in the site's theme, holding each step's question, rendered answer and
 * button as the published card holds them, and nothing of the editor's: no
 * field, placeholder or add-panel control. On a horizontal layout each is held
 * under the side card's ceiling, so it measures as tall as the published card
 * does. The shown step's card is the
 * editor's own, whose height changes with what the author opens, so it plays
 * no part. Each hidden card is measured when laid out and again whenever it
 * changes size; until the shown step's has been measured the scene is taken
 * to stay beside the player, where every scene starts on the published page
 * too.
 *
 * All geometry is framing-stage.ts's; this only gathers the heights it takes.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GlossaryContext } from "~/lib/card-markdown";
import type { MathDelimiter } from "~/components/ui/markdown-editor/panelMath";
import { AnswerRendering } from "~/components/features/editor/AnswerRendering";
import { cardBox, ceilingBox, mediaCardBelow, type MediaBelow, type MediaKind } from "~/lib/framing-stage";
import type { StageGeometry } from "~/hooks/use-stage-geometry";

/** A step of the scene, as its card shows it. */
export interface SceneStepText {
  key: string;
  /** The step the stage shows, whose card is measured by StepCard itself. */
  current: boolean;
  question: string | null;
  answer: string | null;
  /** The first panel's button label; null for a step without a panel, "" for the default label. */
  buttonLabel: string | null;
}

/** The measured heights of a scene's cards, by step key. */
export interface SceneHeights {
  byKey: Record<string, number>;
  onHeight: (key: string, height: number) => void;
}

export function useSceneHeights(): SceneHeights {
  const [byKey, setByKey] = useState<Record<string, number>>({});
  const onHeight = useCallback((key: string, height: number) => {
    setByKey((prev) => (prev[key] === height ? prev : { ...prev, [key]: height }));
  }, []);
  return { byKey, onHeight };
}

/**
 * The scene's arrangement for a video or audio step (`kind`), from its
 * tallest measured card, with a video compared at its own `aspect` where it
 * is known and at 16:9 where it is not; null for an image, before the shown
 * card has been measured, and wherever the cards stay beside the player.
 */
export function sceneBelow(
  geometry: StageGeometry,
  kind: MediaKind | null,
  scene: readonly SceneStepText[],
  heights: SceneHeights,
  aspect: number | null = null,
): MediaBelow | null {
  const shown = scene.find((step) => step.current);
  if (!kind || !shown || heights.byKey[shown.key] === undefined) return null;
  const measured = scene.map((step) => heights.byKey[step.key]).filter((h): h is number => h !== undefined);
  const { layout, window: win } = geometry;
  return mediaCardBelow(layout, win.w, win.h, {
    kind,
    aspect,
    tallestContentHeight: Math.max(...measured),
  });
}

/** One hidden card, reporting its height. */
function MeasuredCard({
  step,
  box,
  glossary,
  delimiters,
  defaultLabel,
  onHeight,
  ceiling,
}: {
  step: SceneStepText;
  box: { x: number; w: number };
  /** The side card's ceiling on a horizontal layout, which the card is held under; null elsewhere. */
  ceiling: number | null;
  glossary: GlossaryContext;
  delimiters?: MathDelimiter[];
  defaultLabel: string;
  onHeight: (key: string, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const measureScene = useCallback(() => {
    const el = ref.current;
    if (el && el.offsetHeight > 0) onHeight(step.key, el.offsetHeight);
  }, [step.key, onHeight]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measureScene();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureScene);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureScene, step.answer, step.question, step.buttonLabel]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="scene-card-measure"
      data-scene-key={step.key}
      className="text-card"
      style={{ left: box.x, top: 0, width: box.w, maxHeight: ceiling ?? undefined, visibility: "hidden", pointerEvents: "none" }}
    >
      <div className="step-content">
        <h2 className="step-question">{step.question}</h2>
        {/* Typeset as the shown answer is, and measured again once it is. */}
        <AnswerRendering
          className="step-answer"
          answer={step.answer ?? ""}
          glossary={glossary}
          delimiters={delimiters}
          onRendered={measureScene}
        />
        {step.buttonLabel !== null && (
          <div className="step-actions">
            <span className="panel-trigger">
              {step.buttonLabel || defaultLabel}
              <span aria-hidden="true"> →</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The scene's other cards, hidden in the visitor layer, each reporting its height. */
export function SceneMeasures({
  geometry,
  scene,
  heights,
  glossary,
  delimiters,
  defaultLabel,
}: {
  geometry: StageGeometry;
  scene: readonly SceneStepText[];
  heights: SceneHeights;
  glossary: GlossaryContext;
  /** The site's formula delimiters, as the shown answer is typeset with. */
  delimiters?: MathDelimiter[];
  defaultLabel: string;
}) {
  const { layout, window: win } = geometry;
  const box = cardBox(layout, win.w, win.h, { media: true });
  const ceiling = layout.mode === "horizontal" ? (ceilingBox(layout, win.w, win.h, { media: true })?.h ?? null) : null;
  return (
    <>
      {scene.map((step) => (
          <MeasuredCard
            key={step.key}
            step={step}
            box={box}
            ceiling={ceiling}
            glossary={glossary}
            delimiters={delimiters}
            defaultLabel={defaultLabel}
            onHeight={heights.onHeight}
          />
      ))}
    </>
  );
}
