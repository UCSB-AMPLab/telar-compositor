/**
 * This file draws the marks of the step line, the narrative line that the
 * Story Editor's step list is drawn as: a filled square for the title card,
 * a circle per step carrying its object type's icon, a larger empty ring per
 * section card, and a triangle for the last row when it is a step. One line
 * joins them, and layer panels branch off their step: layer 1 in the layer-1
 * colour, layer 2 branching again from layer 1's stem.
 *
 * Every mark is drawn in a 36px column with the line at x=20, so the marks
 * of consecutive rows meet. Each row draws its own segment of the line, which
 * stops at the mark's edge so the mark needs no fill to hide it; the mark is
 * filled only when its row is selected.
 *
 * The icon per media type is decided here once (`mediaTypeIcon`), for the
 * mark and for the row's spoken type.
 *
 * @version v1.5.0-beta
 */

import { FileText, ImageIcon, Music, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MediaType } from "~/lib/media-type";

/** The shape a row's mark takes. `end` is the last row when it is a step. */
export type StepLineShape = "title" | "step" | "section" | "end";

/** The Lucide icon for a media type, and the key naming it for a screen reader (none for an image). */
export function mediaTypeIcon(mediaType: MediaType): { Icon: LucideIcon; labelKey: string | null } {
  switch (mediaType) {
    case "youtube":
    case "vimeo":
    case "google-drive":
      return { Icon: Video, labelKey: "media.media_type_video" };
    case "audio":
      return { Icon: Music, labelKey: "media.media_type_audio" };
    case "text-only":
      return { Icon: FileText, labelKey: "media.media_type_text" };
    default:
      return { Icon: ImageIcon, labelKey: null };
  }
}

/** The x of the line in every row's mark column. */
const LINE_X = 20;
const MARK_WIDTH = 36;
const LINE_CLASS = "stroke-cream/55";

/** Row height, the mark's top and bottom edges, for each shape. */
const GEOMETRY: Record<StepLineShape, { height: number; top: number; bottom: number }> = {
  title: { height: 48, top: 16, bottom: 32 },
  step: { height: 30, top: 5.5, bottom: 24.5 },
  section: { height: 36, top: 7, bottom: 29 },
  end: { height: 34, top: 5, bottom: 26 },
};

/** The row height a shape's mark is drawn for, in pixels. */
export function stepLineRowHeight(shape: StepLineShape): number {
  return GEOMETRY[shape].height;
}

function LineSegment({ y1, y2 }: { y1: number; y2: number }) {
  return <line x1={LINE_X} y1={y1} x2={LINE_X} y2={y2} className={LINE_CLASS} strokeWidth={2} />;
}

/** The type icon, `size` square, centred on (`cx`, `cy`). */
function MarkIcon({ mediaType, selected, cx, cy, size }: { mediaType: MediaType; selected: boolean; cx: number; cy: number; size: number }) {
  const { Icon } = mediaTypeIcon(mediaType);
  return (
    <Icon
      x={cx - size / 2}
      y={cy - size / 2}
      size={size}
      strokeWidth={1.8}
      absoluteStrokeWidth
      className={selected ? "text-charcoal" : "text-cream"}
    />
  );
}

function Shape({ shape, selected, mediaType }: { shape: StepLineShape; selected: boolean; mediaType: MediaType }) {
  const fill = selected ? "fill-cream" : "fill-none";
  switch (shape) {
    case "title":
      return <rect x={12} y={16} width={16} height={16} className="fill-cream" />;
    case "section":
      return <circle cx={LINE_X} cy={18} r={11} className={`${fill} stroke-cream`} strokeWidth={2} />;
    case "end":
      return (
        <>
          <path d="M20 5 L32 26 L8 26 Z" className={`${fill} stroke-cream`} strokeWidth={1.5} strokeLinejoin="round" />
          <MarkIcon mediaType={mediaType} selected={selected} cx={LINE_X} cy={20} size={9} />
        </>
      );
    default:
      return (
        <>
          <circle cx={LINE_X} cy={15} r={9.5} className={`${fill} stroke-cream`} strokeWidth={1.5} />
          <MarkIcon mediaType={mediaType} selected={selected} cx={LINE_X} cy={15} size={11} />
        </>
      );
  }
}

interface StepLineMarkProps {
  shape: StepLineShape;
  /** The row is the selected one, which fills its mark. */
  selected?: boolean;
  /** The step's object type, drawn in a circle or triangle. */
  mediaType?: MediaType;
  /** The line continues below the mark, to the next row or a layer branch. */
  lineBelow: boolean;
}

/** One row's mark on the step line, with the line's segments above and below it. */
export function StepLineMark({ shape, selected = false, mediaType = "iiif", lineBelow }: StepLineMarkProps) {
  const { height, top, bottom } = GEOMETRY[shape];
  return (
    <svg
      width={MARK_WIDTH}
      height={height}
      viewBox={`0 0 ${MARK_WIDTH} ${height}`}
      aria-hidden="true"
      className="shrink-0"
      data-shape={shape}
      data-selected={selected ? "true" : undefined}
    >
      {shape !== "title" && <LineSegment y1={0} y2={top} />}
      {lineBelow && <LineSegment y1={bottom} y2={height} />}
      <Shape shape={shape} selected={selected} mediaType={mediaType} />
    </svg>
  );
}

/** Layer-1 and layer-2 colours of the branches and their titles. */
export const LAYER_BRANCH_CLASS: Record<1 | 2, string> = {
  1: "text-anil",
  2: "text-terracotta-soft",
};

const BRANCH_ROW_HEIGHT = 22;
const BRANCH_MID = BRANCH_ROW_HEIGHT / 2;

/** Where each layer's branch leaves its parent line and where it ends. */
const BRANCH: Record<1 | 2, { width: number; from: number; elbow: number; end: number }> = {
  1: { width: 52, from: LINE_X, elbow: 36, end: 44 },
  2: { width: 72, from: 44, elbow: 58, end: 64 },
};

interface StepLineBranchProps {
  level: 1 | 2;
  /** The step's line runs on past this row, to the next step. */
  mainLine: boolean;
  /** Layer 1's stem continues down to a layer 2 below it. */
  stem: boolean;
}

/**
 * A layer row's part of the line: the step's line passing by, and the
 * branch curving off its parent to the layer's dot. The svg is as wide as
 * the branch, so the layer's title starts where its branch ends.
 */
export function StepLineBranch({ level, mainLine, stem }: StepLineBranchProps) {
  const { width, from, elbow, end } = BRANCH[level];
  return (
    <svg
      width={width}
      height={BRANCH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${BRANCH_ROW_HEIGHT}`}
      aria-hidden="true"
      className={`shrink-0 ${LAYER_BRANCH_CLASS[level]}`}
      data-branch={level}
    >
      {mainLine && <LineSegment y1={0} y2={BRANCH_ROW_HEIGHT} />}
      <path
        d={`M${from} 0 Q${from} ${BRANCH_MID} ${elbow} ${BRANCH_MID} L${end} ${BRANCH_MID}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      {stem && <line x1={end} y1={BRANCH_MID} x2={end} y2={BRANCH_ROW_HEIGHT} stroke="currentColor" strokeWidth={1.5} />}
      <circle cx={end} cy={BRANCH_MID} r={4} fill="currentColor" />
    </svg>
  );
}
