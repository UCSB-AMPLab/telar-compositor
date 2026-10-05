/**
 * AltTextChip — a step's description for screen readers, on the image it
 * describes.
 *
 * The published card never shows a step's alt text: it becomes the image's
 * accessible name. So the field sits on the image, as a chip in the region
 * beside the card, above the region's bottom bar, and opens a popover holding
 * the field. The popover is portalled to the document body, outside the
 * stage, and placed in screen pixels under the chip, or over it where the
 * window has no room for it below.
 *
 * The chip names what it does: add a description while there is none, edit
 * it once there is, and carries a mark for the same state, a check or a
 * warning, after its label or, on a compact chip, on its icon's corner. The
 * mark follows the field's live value, as the label does, so it turns as the
 * author types. The label keeps to one line: the chip is as long as it needs,
 * up to the room the stage's chrome gives it, and past that the label is cut
 * with an ellipsis. The field is edited in place as the card's fields are
 * (`useInPlaceEditing`): with a Y.Text the text saves as it is typed; without
 * one, finishing the field saves it through `onSave`, and the popover closes
 * only once the save has landed. A save that fails keeps the popover open
 * with the draft and the failure under it, and a draft left open when the
 * step changes goes to its target's saves. While a failed draft waits for
 * the field, the closed chip carries a dot, with the recovered-draft marker
 * as its description. The dot says nothing about written or empty, so it
 * keeps its own place at the chip's end, clear of the mark.
 *
 * @version v1.5.0-beta
 */

import { useId, useRef, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, PersonStanding } from "lucide-react";
import type * as Y from "yjs";
import { InlineTextArea } from "~/components/ui/InlineTextArea";
import { EditorPopover, elementAnchor } from "~/components/ui/markdown-editor/EditorPopover";
import { InPlaceSaveError, useInPlaceEditing } from "~/components/ui/in-place-editing";

/** The popover's width in screen pixels. */
const POPOVER_WIDTH = 360;

interface AltTextChipProps {
  /** The step's alt text, as the in-place fields key a target. */
  target: string;
  initialValue: string;
  yText: Y.Text | null;
  fieldKey: string;
  /** Show the guidance on writing a description. */
  withHelp?: boolean;
  /** Saves the text, finished without a Y.Text. */
  onSave?: (value: string) => Promise<unknown>;
  /** Shown under a save that failed. */
  saveErrorMessage?: string;
  /** Where a failed draft is kept across a reload of the tab. */
  recoveryKey?: string;
  /** Where the chip sits in the region, in stage pixels from its bottom. */
  bottom?: number;
  /** Where the chip sits on the stage, as the stage's chrome places it; the region's bottom-left otherwise. */
  at?: { x: number; y: number; w: number };
  /** In a compact region, the chip shows its icon only; its words are then its name and its tooltip. */
  compact?: boolean;
  /** Measures the chip for the stage's chrome. */
  measureRef?: (el: HTMLElement | null) => void;
}

/** The chip's classes and position: where the stage's chrome puts it, or the region's bottom-left. */
function chipPlacement(at: AltTextChipProps["at"], compact: boolean, bottom: number | undefined) {
  const padding = compact ? "p-2.5" : "px-4 py-2";
  return {
    className: `group absolute ${at ? "" : "left-3 "}inline-flex items-center gap-2 rounded-full bg-anil-deep ${padding} font-body text-sm font-medium text-white text-left whitespace-nowrap shadow-md hover:bg-anil-ink transition-colors`,
    style: at ? { left: at.x, top: at.y, maxWidth: at.w } : { bottom },
  };
}

export function AltTextChip({
  target,
  initialValue,
  yText,
  fieldKey,
  withHelp,
  onSave,
  saveErrorMessage,
  recoveryKey,
  bottom,
  at,
  compact = false,
  measureRef,
}: AltTextChipProps) {
  const { t } = useTranslation("editor");
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const editing = useInPlaceEditing({
    target,
    yText,
    initialValue,
    fieldKey,
    onSave: yText ? undefined : onSave,
    saveErrorMessage,
    recoveryKey,
  });
  const { binding } = editing;
  const markerId = useId();

  const written = binding.value.trim() !== "";
  const label = written ? t("stage.alt_text_edit") : t("stage.alt_text_add");

  return (
    <>
      <button
        ref={(el) => {
          chipRef.current = el;
          // Escape in the field returns focus to the chip, which stands in for the block.
          (editing.blockRef as unknown as MutableRefObject<HTMLElement | null>).current = el;
          measureRef?.(el);
        }}
        // A compact chip shows only its icon, so the label names it.
        {...(compact ? { "aria-label": label, title: label } : {})}
        type="button"
        data-testid="alt-text-chip"
        aria-expanded={editing.editing}
        aria-describedby={editing.waiting ? markerId : undefined}
        data-recovered={editing.waiting || undefined}
        // Pressing the chip while the field is open must not blur the field
        // first: the click then finishes it once, as a blur would.
        onMouseDown={(event) => {
          if (editing.editing) event.preventDefault();
        }}
        onClick={() => (editing.editing ? editing.done("blur") : editing.open())}
        {...chipPlacement(at, compact, bottom)}
      >
        <ChipIcon written={written} compact={compact} />
        {!compact && (
          <>
            <span className="min-w-0 truncate">{label}</span>
            <AltTextMark written={written} />
          </>
        )}
        {editing.waiting && (
          <span data-in-place-marker="" aria-hidden="true" className="w-2 h-2 rounded-full bg-terracotta ring-2 ring-white shrink-0" />
        )}
      </button>
      {/* Outside the button, so it describes the chip rather than joining its name. */}
      {editing.waiting && (
        <span id={markerId} className="sr-only">
          {t("in_place.recovered_marker")}
        </span>
      )}
      {editing.editing && chipRef.current && (
        <AltTextPopover
          chip={chipRef.current}
          editing={editing}
          withHelp={withHelp}
          initialValue={initialValue}
          yText={yText}
          fieldKey={fieldKey}
        />
      )}
    </>
  );
}

/** The chip's icon; a compact chip, which has no label, carries the mark on its corner. */
function ChipIcon({ written, compact }: { written: boolean; compact: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      <PersonStanding className="w-4 h-4" aria-hidden="true" />
      {compact && <AltTextMark written={written} badge />}
    </span>
  );
}

/**
 * Whether the step's description is written: a check once it is, a warning
 * while it is not, each in its status tone's pale disc with the deep ink, the
 * disc standing clear of the chip's blue. The label names the state, so the
 * mark is decorative. As a badge it stays inside the chip's padding, so it
 * leaves the chip's measured size as it is; its ring follows the chip's hover.
 */
function AltTextMark({ written, badge = false }: { written: boolean; badge?: boolean }) {
  const Icon = written ? Check : AlertTriangle;
  const tone = written ? "bg-chilca-pale text-chilca-deep" : "bg-qolle-pale text-qolle-deep";
  const place = badge ? "absolute -top-2 -right-2 w-4 h-4 ring-2 ring-anil-deep group-hover:ring-anil-ink" : "w-5 h-5";
  return (
    <span
      data-alt-text-mark={written ? "written" : "empty"}
      aria-hidden="true"
      className={`${place} inline-flex items-center justify-center rounded-full shrink-0 ${tone}`}
    >
      <Icon className={badge ? "w-3 h-3" : "w-3.5 h-3.5"} strokeWidth={2.5} />
    </span>
  );
}

/** The alt text's field, in a popover at the chip. */
function AltTextPopover({
  chip,
  editing,
  withHelp,
  initialValue,
  yText,
  fieldKey,
}: Pick<AltTextChipProps, "withHelp" | "initialValue" | "yText" | "fieldKey"> & {
  chip: HTMLElement;
  editing: ReturnType<typeof useInPlaceEditing>;
}) {
  const { t } = useTranslation("editor");
  return (
    <EditorPopover
      anchor={elementAnchor(chip)}
      width={POPOVER_WIDTH}
      onDetach={() => editing.done("blur")}
      role="dialog"
      aria-label={t("step.alt_text_section")}
    >
      <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">{t("step.alt_text_section")}</h4>
      {withHelp && <p className="font-body text-xs text-gray-500 mb-3">{t("step.alt_text_help")}</p>}
      <InlineTextArea
        initialValue={initialValue}
        yText={yText}
        binding={editing.binding}
        placeholder={t("step.alt_text_placeholder")}
        inputClassName="font-body text-sm text-charcoal"
        rows={3}
        fieldKey={fieldKey}
        autoFocus
        onDone={editing.done}
      />
      <InPlaceSaveError editing={editing} />
    </EditorPopover>
  );
}
