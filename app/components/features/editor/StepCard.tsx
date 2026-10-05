/**
 * StepCard — a step's text card as the published page draws it, edited in
 * place on the framing stage.
 *
 * The card is the framework's `.text-card` in the site's theme
 * (`visitor-layer.css`), laid out at the visitor's size in the visitor
 * layer. Its box comes from `framing-stage.ts`: a side card is as tall as its
 * content up to the ceiling, which is measured here and handed back to
 * `cardBox` for the card's top, and a bottom card has the fixed height the
 * framework's stylesheet gives it and scrolls. On a horizontal layout the
 * answer keeps its size and the card cuts what does not fit under the
 * ceiling, as the published card does. The side card's
 * ceiling is drawn as a dashed box beside the card, the one mark of the
 * editor's own.
 *
 * The question and the answer are edited in place: each shows as the visitor
 * reads it and becomes a field when it, or the pencil after it, is clicked.
 * The layer button opens its panel, as it does for the visitor, and the
 * pencil beside it turns its label into a field. The
 * answer shows as the build publishes it (`answerHtml`: rendered as a panel
 * is, made prose, glossary links, and the cut at the budget), with its
 * formulas typeset as the site typesets them. A glossary
 * link in it is never followed from here: its address belongs to the
 * published site.
 *
 * With a Y.Text a field saves as it is typed; without one, `onSaveField`
 * saves it when the field is finished.
 *
 * A step with no panel offers to add one where its button would be.
 *
 * @version v1.5.0-beta
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Pencil, PencilLine } from "lucide-react";
import type * as Y from "yjs";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";
import {
  InPlaceBlock,
  InPlaceSaveError,
  useInPlaceEditing,
  type InPlaceCommonProps,
  type InPlaceEditing,
} from "~/components/ui/in-place-editing";
import type { GlossaryContext } from "~/lib/card-markdown";
import { AnswerRendering } from "~/components/features/editor/AnswerRendering";
import { cardBox, ceilingBox, type MediaBelow } from "~/lib/framing-stage";
import type { MathDelimiter } from "~/components/ui/markdown-editor/panelMath";
import type { StageGeometry } from "~/hooks/use-stage-geometry";
import { useTextEnd } from "~/hooks/use-text-end";

export type StepTextField = "question" | "answer";

interface StepCardProps {
  geometry: StageGeometry;
  /** The step shows a video or audio plate, which sizes the vertical card. */
  media: boolean;
  step: { id: number; question: string | null; answer: string | null };
  /** The step being edited, as the editor keys a selection. */
  target: string;
  /** The awareness key's stem for the step's fields. */
  fieldKeyPrefix: string;
  questionYText: Y.Text | null;
  answerYText: Y.Text | null;
  /** Saves a field finished without a Y.Text. */
  onSaveField?: (field: StepTextField, value: string) => Promise<unknown>;
  /** The step's first panel, whose button the card shows. */
  layer1: { id: number; button_label: string | null } | null;
  buttonLabelYText: Y.Text | null;
  /** Saves the button's label, finished without a Y.Text. */
  onSaveButtonLabel?: (value: string) => Promise<unknown>;
  onCreateLayer: () => void;
  /** Opens the first panel, as its button does on the published page, from the button pressed. */
  onOpenLayer: (opener: HTMLElement) => void;
  glossary: GlossaryContext;
  /** The site's formula delimiters; formulas stay as typed without them. */
  delimiters?: MathDelimiter[];
  /** Shown under a save that failed. */
  saveErrorMessage?: string;
  /** Told the answer as its field holds it, draft included. */
  onAnswerChange?: (value: string) => void;
  /** Told the question as its field holds it, draft included. */
  onQuestionChange?: (value: string) => void;
  /** Told the first panel's button label as its field holds it, draft included. */
  onButtonLabelChange?: (value: string) => void;
  /**
   * Where a failed draft of each field is kept across a reload of the tab
   * (`project:<id>/step:<id>/question` and so on); absent for a field whose
   * row has no id yet.
   */
  recoveryKeys?: { question?: string; answer?: string; buttonLabel?: string };
  /** A media scene's arrangement with its cards below the player (`mediaCardBelow`), or null. */
  below?: MediaBelow | null;
  /**
   * The published card's height, measured from its hidden rendering. With the
   * card below the player it places the card, lifted by the editor's rows
   * (Add panel) so that the card holds them where the published card would not
   * scroll; a field opened in it extends downwards inside the window.
   */
  publishedHeight?: number;
  /** With the card below the player, the player's lowest edge in visitor pixels: the card is lifted no higher. */
  playerBottom?: number;
}

/**
 * The answer, edited in place as InPlaceText edits a text, from the same
 * parts, so the card holds the binding the field edits: the line count
 * beside the card (`onValue`) reads the author's draft as it is typed, and
 * each revalidated value the field adopts, not a copy of its own.
 *
 * A section card's answer is edited with it too (SectionCardView), with no
 * pencil and its own words for what the field refuses.
 */

/**
 * The route save for a text field with no Y.Text: none where the field has a
 * Y.Text (it saves as it is typed) or nothing saves through the route.
 */
export function routeSaveFor(onSaveField?: (field: StepTextField, value: string) => Promise<unknown>) {
  return (yText: Y.Text | null, field: StepTextField) =>
    yText || !onSaveField ? undefined : (value: string) => onSaveField(field, value);
}

export function AnswerField({
  glossary,
  delimiters,
  onValue,
  pencilLabel,
  textOnlyMessageKey,
  ...common
}: InPlaceCommonProps & {
  glossary: GlossaryContext;
  delimiters?: MathDelimiter[];
  onValue?: (value: string) => void;
  pencilLabel?: string;
  textOnlyMessageKey?: string;
}) {
  const editing = useInPlaceEditing(common);
  const pencil = useFieldPencil(editing);
  const markerId = useId();
  const typeset = useRef<(() => void) | null>(null);
  const { binding } = editing;
  useEffect(() => {
    onValue?.(binding.value);
  }, [binding.value, onValue]);

  if (!editing.editing) {
    return (
      <>
        <InPlaceBlock
          editing={editing}
          empty={!binding.value}
          placeholder={common.placeholder}
          label={common.label}
          fieldKey={common.fieldKey}
          markerId={markerId}
        >
          <AnswerRendering
            answer={binding.value}
            glossary={glossary}
            delimiters={delimiters}
            onRendered={() => typeset.current?.()}
          />
        </InPlaceBlock>
        {pencilLabel && (
          <FieldPencil
            editing={pencil}
            label={pencilLabel}
            markerId={markerId}
            text={editing.blockRef}
            value={binding.value}
            measureRef={typeset}
          />
        )}
      </>
    );
  }
  return (
    <div>
      <InlineTextArea
        initialValue={common.initialValue}
        yText={common.yText}
        binding={binding}
        fieldKey={common.fieldKey}
        placeholder={common.placeholder}
        autoFocus
        grow
        onDone={editing.done}
        textOnly
        textOnlyMessageKey={textOnlyMessageKey}
        rows={5}
        inputClassName="font-mono text-sm"
      />
      <InPlaceSaveError editing={editing} />
    </div>
  );
}

/**
 * The field as its pencil opens it: the same field, whose Escape puts focus
 * back on the pencil when the pencil opened it. The field's own return, to
 * its block, runs first; the pencil takes focus from the block only.
 */
function useFieldPencil(editing: InPlaceEditing): InPlaceEditing {
  const pencilRef = useRef<HTMLDivElement | null>(null);
  const openedByPencil = useRef(false);
  const { blockRef } = editing;
  useEffect(() => {
    if (editing.editing) return;
    if (openedByPencil.current && document.activeElement === blockRef.current) pencilRef.current?.focus();
    openedByPencil.current = false;
  }, [editing.editing, blockRef]);
  return {
    ...editing,
    blockRef: pencilRef,
    open: () => {
      openedByPencil.current = true;
      editing.open();
    },
  };
}

/**
 * The pencil after a question or an answer, which opens its field as the
 * text does, named `label`, and worded `label` on the card's bottom line
 * (`useCardHint`). It points at the waiting draft's marker the text's block
 * draws, and outlines no presence: the text does.
 *
 * It stands just past the end of the text's last line, centred on that line
 * (`useTextEnd`, from `text`, the text's block), in a box of no size placed
 * absolutely, so the lines and height stay the published card's
 * (visitor-layer.css). `value` is what the block shows; `measureRef` takes
 * the measure, for a formula typeset after the render.
 */
function FieldPencil({
  editing,
  label,
  markerId,
  text,
  value,
  measureRef,
}: {
  editing: InPlaceEditing;
  label: string;
  markerId: string;
  text: RefObject<HTMLElement | null>;
  value: string;
  measureRef?: MutableRefObject<(() => void) | null>;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const { at, measure } = useTextEnd(text, boxRef, [value]);
  useEffect(() => {
    if (measureRef) measureRef.current = measure;
  }, [measureRef, measure]);
  return (
    <span ref={boxRef} className="stage-field-pencil" data-stage-pencil={label} style={at ?? undefined}>
      <InPlaceBlock
        editing={editing}
        empty={false}
        label={label}
        markerId={markerId}
        markerElsewhere
        className="inline-flex items-center p-1 rounded text-gray-400 hover:text-charcoal hover:bg-gray-100 transition-colors cursor-pointer!"
      >
        <Pencil className="w-3 h-3" aria-hidden="true" />
      </InPlaceBlock>
    </span>
  );
}

/**
 * A text edited in place as InPlaceText edits it, from the same parts, telling
 * `onValue` the text its field holds, draft included: the scene's hidden
 * card of the shown step is laid out from it.
 *
 * With `opener`, the value is not what opens the field: the block shows
 * `opener.content` in its place, and `opener.around` sets it beside the
 * value, drawn as the caller draws it. With `pencilLabel`, the value opens
 * the field and so does the pencil beside it.
 *
 * The layer panels edit their titles and layer 2's button label with it too
 * (LayerPanel).
 */
export function ReportedText({
  onValue,
  renderValue,
  fieldProps = {},
  opener,
  pencilLabel,
  ...common
}: InPlaceCommonProps & {
  onValue?: (value: string) => void;
  renderValue?: (value: string) => ReactNode;
  fieldProps?: { bordered?: boolean; inputClassName?: string };
  opener?: { content: ReactNode; around: (value: string, block: ReactNode) => ReactNode };
  pencilLabel?: string;
}) {
  const editing = useInPlaceEditing(common);
  const pencil = useFieldPencil(editing);
  const markerId = useId();
  const { binding } = editing;
  useEffect(() => {
    onValue?.(binding.value);
  }, [binding.value, onValue]);

  if (!editing.editing) {
    const block = (
      <InPlaceBlock
        editing={editing}
        empty={!opener && !binding.value}
        placeholder={common.placeholder}
        label={common.label}
        className={common.className}
        fieldKey={common.fieldKey}
        markerId={markerId}
      >
        {opener ? opener.content : renderValue ? renderValue(binding.value) : binding.value}
      </InPlaceBlock>
    );
    if (opener) return <>{opener.around(binding.value, block)}</>;
    if (!pencilLabel) return block;
    return (
      <>
        {block}
        <FieldPencil editing={pencil} label={pencilLabel} markerId={markerId} text={editing.blockRef} value={binding.value} />
      </>
    );
  }
  return (
    <div>
      <InlineTextField
        initialValue={common.initialValue}
        yText={common.yText}
        binding={binding}
        fieldKey={common.fieldKey}
        placeholder={common.placeholder}
        autoFocus
        grow
        onDone={editing.done}
        bordered={fieldProps.bordered}
        inputClassName={fieldProps.inputClassName}
      />
      <InPlaceSaveError editing={editing} />
    </div>
  );
}

export function StepCard({
  geometry,
  media,
  step,
  target,
  fieldKeyPrefix,
  questionYText,
  answerYText,
  onSaveField,
  layer1,
  buttonLabelYText,
  onSaveButtonLabel,
  onCreateLayer,
  onOpenLayer,
  glossary,
  delimiters,
  saveErrorMessage,
  onAnswerChange,
  onQuestionChange,
  onButtonLabelChange,
  recoveryKeys = {},
  below = null,
  publishedHeight,
  playerBottom,
}: StepCardProps) {
  const { t } = useTranslation("editor");
  const { layout } = geometry;
  const cardRef = useRef<HTMLDivElement>(null);
  const side = layout.cardPlacement === "side";
  const contentHeight = useSideCardHeight(cardRef, side);
  const addPanelRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const editorRows = useEditorRowsHeight(addPanelRef, answerRef, !layer1);
  const { ceiling, cardStyle } = cardPlacement(geometry, { media, below, publishedHeight, contentHeight, editorRows, playerBottom });

  const saveIf = routeSaveFor(onSaveField);
  const hint = useCardHint();

  return (
    <>
      {ceiling && (
        <div
          data-testid="card-ceiling"
          role="img"
          aria-label={t("stage.card_ceiling")}
          className="card-ceiling"
          style={{ left: ceiling.x, top: ceiling.y, width: ceiling.w, height: ceiling.h }}
        />
      )}
      <div
        ref={cardRef}
        data-testid="step-card"
        data-placement={layout.cardPlacement}
        className="text-card"
        style={cardStyle}
        {...hint.handlers}
      >
        <div className="step-content">
          <h2 className="step-question">
            <ReportedText
              onValue={onQuestionChange}
              target={`${target}:question`}
              yText={questionYText}
              initialValue={step.question ?? ""}
              placeholder={t("step.question_placeholder")}
              label={t("step.question_placeholder")}
              fieldKey={`${fieldKeyPrefix}-question`}
              onSave={saveIf(questionYText, "question")}
              saveErrorMessage={saveErrorMessage}
              recoveryKey={recoveryKeys.question}
              fieldProps={{ bordered: true }}
              pencilLabel={t("stage.edit_question")}
            />
          </h2>

          <div ref={answerRef} className="step-answer group/answer">
            <p
              className="hidden group-has-[textarea]/answer:block font-body text-xs uppercase tracking-wider text-anil-ink mb-1"
            >
              {t("stage.answer_field_label")}
            </p>
            <AnswerField
              target={`${target}:answer`}
              yText={answerYText}
              initialValue={step.answer ?? ""}
              placeholder={t("step.answer_placeholder")}
              label={t("step.answer_placeholder")}
              fieldKey={`${fieldKeyPrefix}-answer`}
              onSave={saveIf(answerYText, "answer")}
              saveErrorMessage={saveErrorMessage}
              recoveryKey={recoveryKeys.answer}
              glossary={glossary}
              delimiters={delimiters}
              onValue={onAnswerChange}
              pencilLabel={t("stage.edit_answer")}
            />
            <p className="hidden group-has-[textarea]/answer:block font-body text-xs text-gray-500 mt-1">
              {t("stage.answer_field_hint")}
            </p>
          </div>

          <div ref={addPanelRef} className="step-actions" data-editor-row={layer1 ? undefined : "add-panel"}>
            <PanelButton
              target={target}
              fieldKeyPrefix={fieldKeyPrefix}
              layer1={layer1}
              buttonLabelYText={buttonLabelYText}
              onSaveButtonLabel={onSaveButtonLabel}
              onCreateLayer={onCreateLayer}
              onOpenLayer={onOpenLayer}
              onButtonLabelChange={onButtonLabelChange}
              saveErrorMessage={saveErrorMessage}
              recoveryKey={recoveryKeys.buttonLabel}
            />
          </div>

          <span
            data-testid="card-hint"
            data-kind={hint.words ? "pencil" : "edit"}
            aria-hidden="true"
            className="stage-card-hint inline-flex items-center gap-1 font-body"
          >
            {hint.words ?? (
              <>
                <PencilLine className="w-3 h-3" aria-hidden="true" />
                {t("stage.edit_hint")}
              </>
            )}
          </span>
        </div>
      </div>
    </>
  );
}

/**
 * What the card's bottom line says: the words of the pencil under a mouse or
 * pen, else of the pencil holding focus, else (null) the edit hint. The line
 * is one element, so it shows one text at a time; the stylesheet decides
 * only whether it shows (visitor-layer.css). A touch is not a hover: on a
 * touch screen a pencil's words show once it holds focus.
 *
 * A pencil is found by its `data-stage-pencil` box, which holds its words.
 * A pencil that goes, as its field opens, says nothing: every focus inside
 * the card re-renders it (a new record each time), and the field's input
 * takes focus as it opens, so the card then finds the pencil disconnected.
 */
function useCardHint() {
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const [focused, setFocused] = useState<{ pencil: HTMLElement | null }>({ pencil: null });
  const pencilOf = (node: EventTarget | null) =>
    node instanceof Element ? node.closest<HTMLElement>("[data-stage-pencil]") : null;
  const wordsOf = (el: HTMLElement | null) => (el?.isConnected ? (el.dataset.stagePencil ?? null) : null);
  return {
    words: wordsOf(hovered) ?? wordsOf(focused.pencil),
    handlers: {
      onPointerOver: (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== "touch") setHovered(pencilOf(event.target));
      },
      onPointerLeave: () => setHovered(null),
      onFocus: (event: FocusEvent<HTMLDivElement>) => setFocused({ pencil: pencilOf(event.target) }),
      onBlur: () => setFocused({ pencil: null }),
    },
  };
}

/**
 * A side card's height is its content's, up to the ceiling: measured at the
 * visitor's size (offsetHeight ignores the layer's scale) whenever it
 * changes, as text is typed or the theme's fonts arrive.
 */
function useSideCardHeight(cardRef: RefObject<HTMLDivElement | null>, side: boolean): number | undefined {
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || !side) return;
    const measureCard = () => setContentHeight(el.offsetHeight > 0 ? el.offsetHeight : undefined);
    measureCard();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureCard);
    observer.observe(el);
    return () => observer.disconnect();
  }, [cardRef, side]);
  return contentHeight;
}

/**
 * The height the editor's rows add to the published card, at the visitor's
 * size: the add-panel row with its bottom margin, where the step has no panel
 * and the published card has no button line; and, where the answer is empty,
 * the answer's placeholder line and the row's top margin besides. The published
 * card has no placeholder there, and the row's top margin, which otherwise
 * falls in the answer's closing paragraph margin, then stands on its own. The
 * rows are measured, not the card's whole content against the published card:
 * a field the author opens would then lift the card as they type. The card's
 * bottom line (`useCardHint`) sits in the card's bottom padding and adds nothing.
 */
function useEditorRowsHeight(
  rowRef: RefObject<HTMLDivElement | null>,
  answerRef: RefObject<HTMLDivElement | null>,
  shown: boolean,
): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !shown) {
      setHeight(0);
      return;
    }
    const answer = answerRef.current;
    const margin = (el: HTMLElement, side: "marginTop" | "marginBottom") => parseFloat(getComputedStyle(el)[side]) || 0;
    const measureRows = () => {
      const placeholder = answer?.querySelector<HTMLElement>("[data-in-place][data-empty]");
      const empty = placeholder ? placeholder.offsetHeight + margin(row, "marginTop") : 0;
      setHeight(row.offsetHeight + margin(row, "marginBottom") + empty);
    };
    measureRows();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRows);
    observer.observe(row);
    if (answer) observer.observe(answer);
    return () => observer.disconnect();
  }, [rowRef, answerRef, shown]);
  return height;
}

/**
 * The card's box and ceiling as the published page places them. A card below
 * its player is placed from the scene's published card and has no ceiling
 * drawn: the published card never reaches one there, since a card that tall
 * keeps the scene beside. It is lifted by the editor's rows, so the stage card
 * does not scroll where the published card would not, and no higher than the
 * player's lowest edge; what the lift cannot hold scrolls.
 */
function cardPlacement(
  { layout, window: win }: StageGeometry,
  {
    media,
    below,
    publishedHeight,
    contentHeight,
    editorRows,
    playerBottom,
  }: {
    media: boolean;
    below: MediaBelow | null;
    publishedHeight?: number;
    contentHeight?: number;
    editorRows: number;
    playerBottom?: number;
  },
) {
  const side = layout.cardPlacement === "side";
  const belowPlayer = side && below !== null && layout.mode === "horizontal";
  const placedHeight = belowPlayer ? (publishedHeight ?? contentHeight) : contentHeight;
  const box = cardBox(layout, win.w, win.h, { media, below, contentHeight: side ? placedHeight : undefined });
  const ceiling = belowPlayer ? null : ceilingBox(layout, win.w, win.h, { media });
  const at = { left: box.x, top: box.y, width: box.w };
  if (belowPlayer) {
    const top = liftedTop(box.y, editorRows, playerBottom);
    return { ceiling, cardStyle: { ...at, top, maxHeight: win.h - top, overflowY: "auto" as const } };
  }
  if (side) {
    // A vertical layout's card scrolls past its ceiling, a sideways phone's
    // included; a horizontal layout's cuts, since the fit model governs it.
    const overflowY = layout.mode === "vertical" ? ("auto" as const) : undefined;
    return { ceiling, cardStyle: { ...at, maxHeight: ceiling?.h, overflowY } };
  }
  return { ceiling, cardStyle: { ...at, height: box.h } };
}

/** The card's top lifted by `rows`, no higher than `floor`, the player's lowest edge; unlifted without one. */
function liftedTop(top: number, rows: number, floor: number | undefined): number {
  return floor === undefined ? top : Math.min(top, Math.max(top - rows, floor));
}

/**
 * The step's panel button, which opens the panel, with the pencil beside it
 * that edits its label in place; or the button that adds the first panel.
 *
 * The pencil stands in a box of no size after the button, overflowing it, so
 * the button's line keeps the height and the breaks the published card gives
 * it, and the card measures as the published card does. The box is not
 * positioned: the recovered-draft marker the block carries is placed against
 * the card, as every field's is. The pencil's words show on the card's
 * bottom line (`useCardHint`), since a button as wide as the card leaves no room
 * for them beside it.
 */
function PanelButton({
  target,
  fieldKeyPrefix,
  layer1,
  buttonLabelYText,
  onSaveButtonLabel,
  onCreateLayer,
  onOpenLayer,
  onButtonLabelChange,
  saveErrorMessage,
  recoveryKey,
}: Pick<
  StepCardProps,
  | "target"
  | "fieldKeyPrefix"
  | "layer1"
  | "buttonLabelYText"
  | "onSaveButtonLabel"
  | "onCreateLayer"
  | "onOpenLayer"
  | "onButtonLabelChange"
  | "saveErrorMessage"
> & { recoveryKey?: string }) {
  const { t } = useTranslation("editor");
  if (!layer1) {
    return (
      <button
        type="button"
        onClick={onCreateLayer}
        className="px-5 py-2 border-2 border-dashed border-gray-300 text-gray-500 font-heading text-sm rounded-full hover:border-charcoal hover:text-charcoal transition-colors"
      >
        {t("layer.add_panel")}
      </button>
    );
  }
  const placeholder = t("layer.default_label_1");
  return (
    <ReportedText
      onValue={onButtonLabelChange}
      target={`${target}:layer1-button`}
      yText={buttonLabelYText}
      initialValue={layer1.button_label ?? ""}
      placeholder={placeholder}
      label={t("layer.edit_button_label_aria")}
      fieldKey={`${fieldKeyPrefix}-layer1-button_label`}
      onSave={buttonLabelYText ? undefined : onSaveButtonLabel}
      saveErrorMessage={saveErrorMessage}
      recoveryKey={recoveryKey}
      className="ml-1 inline-flex items-center p-1 rounded text-gray-400 hover:text-charcoal hover:bg-gray-100 transition-colors cursor-pointer!"
      opener={{
        content: <Pencil className="w-3 h-3" aria-hidden="true" />,
        around: (value, pencil) => (
          <>
            <button type="button" className="panel-trigger text-left" onClick={(e) => onOpenLayer(e.currentTarget)}>
              {value ? (
                <>
                  {value}
                  <span aria-hidden="true"> →</span>
                </>
              ) : (
                <span className="text-gray-400">{placeholder}</span>
              )}
            </button>
            <span
              className="inline-flex items-center w-0 h-0 align-middle whitespace-nowrap"
              data-stage-pencil={t("layer.edit_button_label")}
            >
              {pencil}
            </span>
          </>
        ),
      }}
    />
  );
}
