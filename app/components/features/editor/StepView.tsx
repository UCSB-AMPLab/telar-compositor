/**
 * StepView — editor panel for a regular story step (1-N).
 *
 * Renders inline-editable question, answer, and alt_text fields that write
 * directly to Yjs Y.Text instances via InlineTextField/InlineTextArea.
 * Falls back to initialValue (from D1 SSR render) when yText is null
 * (pre-connection or SSR).
 *
 * Layer buttons (up to 2) appear below the answer, styled as pills.
 * Each layer button has a pencil icon to edit the button label inline.
 * Vertically centered within the narrative column.
 *
 * @version v1.3.0-beta
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Check, X, PencilLine } from "lucide-react";
import * as Y from "yjs";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";
import { DocsLink } from "~/components/ui/DocsLink";
import { useCollaborationContext } from "~/hooks/use-collaboration";

interface LayerData {
  id: number;
  step_id: number;
  layer_number: number;
  title: string | null;
  button_label: string | null;
  content: string | null;
}

interface StepViewProps {
  step: {
    id: number;
    step_number: number;
    question: string | null;
    answer: string | null;
    alt_text: string | null;
  };
  layers: LayerData[];
  onOpenLayer: (layer: LayerData) => void;
  onCreateLayer: (stepId: number, layerNumber: number, defaultLabel: string) => void;
  actionUrl: string;
  isFirstStep?: boolean;
  questionYText: Y.Text | null;
  answerYText: Y.Text | null;
  altTextYText: Y.Text | null;
  /** Y.Text for layer 1's button_label — the SAME Y.Text the panel strip writes. */
  buttonLabelYText: Y.Text | null;
  storySlug: string;
  /** Callback to open the in-product docs drawer — threaded from the _app shell via outlet context. */
  onOpenDoc?: (id: string) => void;
}

/** Inline editor for a layer button label — appears on pencil click. */
function LayerButtonWithEdit({
  layer,
  defaultLabel,
  buttonClassName,
  onOpenLayer,
  buttonLabelYText,
}: {
  layer: LayerData;
  defaultLabel: string;
  buttonClassName: string;
  onOpenLayer: (layer: LayerData) => void;
  buttonLabelYText: Y.Text | null;
}) {
  const { t } = useTranslation("editor");
  const { ydoc } = useCollaborationContext();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(layer.button_label ?? defaultLabel);
  const inputRef = useRef<HTMLInputElement>(null);

  // Replace the contents of a Y.Text without losing the shared identity (so
  // remote observers — and the panel strip writing the same Y.Text — see a
  // single update, not a destroy+create). Copied from LayerPanel.tsx.
  const writeYText = useCallback(
    (yText: Y.Text | null, value: string): boolean => {
      if (!ydoc || !yText) return false;
      ydoc.transact(() => {
        if (yText.length > 0) yText.delete(0, yText.length);
        if (value.length > 0) yText.insert(0, value);
      });
      return true;
    },
    [ydoc]
  );

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Re-seed the local edit buffer whenever the shared button_label changes
  // (panel strip write or remote peer) AND the inline editor is NOT open.
  // Without this the buffer is seeded once at mount and only re-synced on
  // Cancel, so opening the pencil after an external change shows a STALE value
  // and Save would clobber the newer shared value with the stale snapshot.
  // Guarded on !editing so we never stomp the user's in-progress typing.
  useEffect(() => {
    if (!editing) setLabel(layer.button_label ?? defaultLabel);
  }, [layer.button_label, defaultLabel, editing]);

  const handleSave = useCallback(() => {
    setEditing(false);
    const trimmed = label.trim() || defaultLabel;
    setLabel(trimmed);
    writeYText(buttonLabelYText, trimmed);
  }, [label, defaultLabel, buttonLabelYText, writeYText]);

  const handleCancel = useCallback(() => {
    setLabel(layer.button_label ?? defaultLabel);
    setEditing(false);
  }, [layer.button_label, defaultLabel]);

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") handleCancel();
          }}
          className="px-3 py-1.5 font-heading font-semibold text-sm text-charcoal bg-white border border-gray-300 rounded-full min-w-[8rem]"
        />
        <button
          type="button"
          onClick={handleSave}
          className="p-1 text-green-600 hover:text-green-700 transition-colors"
          aria-label={t("step.save_label_aria")}
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleCancel}
          className="p-1 text-gray-400 hover:text-charcoal transition-colors"
          aria-label={t("step.cancel_editing_aria")}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 group/btn">
      <button
        type="button"
        onClick={() => onOpenLayer(layer)}
        className={buttonClassName}
      >
        {layer.button_label ?? defaultLabel}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group/pencil flex items-center gap-1 p-1.5 text-gray-300 hover:text-charcoal transition-all rounded hover:bg-gray-100"
        aria-label={t("step.edit_button_label_aria")}
      >
        <Pencil className="w-3 h-3" />
        <span className="font-body text-xs text-gray-400 opacity-0 group-hover/pencil:opacity-100 transition-opacity">
          {t("layer.edit_button_label")}
        </span>
      </button>
    </span>
  );
}

export function StepView({
  step,
  layers,
  onOpenLayer,
  onCreateLayer,
  isFirstStep,
  questionYText,
  answerYText,
  altTextYText,
  buttonLabelYText,
  storySlug,
  onOpenDoc,
}: StepViewProps) {
  const { t } = useTranslation("editor");
  const questionRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  const layer1 = layers.find((l) => l.layer_number === 1) ?? null;
  const layer2 = layers.find((l) => l.layer_number === 2) ?? null;

  function focusField(containerRef: React.RefObject<HTMLDivElement | null>) {
    const el = containerRef.current?.querySelector("input, textarea") as HTMLElement | null;
    el?.focus();
  }

  return (
    <div className="min-h-full flex flex-col justify-center">
      <div className="px-6 py-8 border-l-4 border-anil">
        {/* Question + Answer card */}
        <div className="rounded-lg bg-white px-5 py-6 shadow-sm border border-gray-100 min-h-[200px]">
          {/* Docs link */}
          <div className="flex justify-end mb-4">
            {onOpenDoc && (
              <DocsLink docId="narrative" onOpenDoc={onOpenDoc} />
            )}
          </div>
          {/* Question */}
          <div className="group/field relative mb-6" ref={questionRef}>
            <button
              type="button"
              onClick={() => focusField(questionRef)}
              className="absolute top-0 right-0 flex items-center gap-1 cursor-pointer"
            >
              <span className="font-body text-xs text-gray-400 opacity-0 group-hover/field:opacity-100 transition-opacity">
                {t("step.click_to_edit")}
              </span>
              <PencilLine className="w-3.5 h-3.5 text-gray-300 group-hover/field:text-charcoal transition-colors" />
            </button>
            <InlineTextField
              initialValue={step.question ?? ""}
              yText={questionYText}
              placeholder={t("step.question_placeholder")}
              inputClassName="font-heading text-xl font-semibold text-charcoal"
              fieldKey={`step-${storySlug}-${step.id}-question`}
            />
          </div>

          {/* Answer */}
          <div className="group/field relative" ref={answerRef}>
            <button
              type="button"
              onClick={() => focusField(answerRef)}
              className="absolute top-0 right-0 flex items-center gap-1 cursor-pointer"
            >
              <span className="font-body text-xs text-gray-400 opacity-0 group-hover/field:opacity-100 transition-opacity">
                {t("step.click_to_edit")}
              </span>
              <PencilLine className="w-3.5 h-3.5 text-gray-300 group-hover/field:text-charcoal transition-colors" />
            </button>
            <InlineTextArea
              initialValue={step.answer ?? ""}
              yText={answerYText}
              placeholder={t("step.answer_placeholder")}
              inputClassName="font-body text-base text-charcoal"
              rows={5}
              fieldKey={`step-${storySlug}-${step.id}-answer`}
            />
          </div>
        </div>

        {/* Accessibility section */}
        <div className="mt-4">
          <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">
            {t("step.alt_text_section")}
          </h4>
          {isFirstStep && (
            <p className="font-body text-xs text-gray-500 mb-3">
              {t("step.alt_text_help")}
            </p>
          )}
          <div className="group/field relative">
            <InlineTextArea
              initialValue={step.alt_text ?? ""}
              yText={altTextYText}
              placeholder={t("step.alt_text_placeholder")}
              inputClassName="font-body text-sm text-gray-500"
              rows={2}
              fieldKey={`step-${storySlug}-${step.id}-alt_text`}
            />
          </div>
        </div>

        {/* Layer buttons */}
        <div className="mt-6 flex flex-wrap gap-2">
          {layer1 ? (
            <LayerButtonWithEdit
              layer={layer1}
              defaultLabel={t("layer.default_label_1")}
              buttonClassName="px-5 py-2 bg-anil/40 text-charcoal font-heading font-semibold text-sm rounded-full hover:bg-anil/60 transition-colors"
              onOpenLayer={onOpenLayer}
              buttonLabelYText={buttonLabelYText}
            />
          ) : (
            <button
              type="button"
              onClick={() => onCreateLayer(step.id, 1, t("layer.default_label_1"))}
              className="px-5 py-2 border-2 border-dashed border-gray-300 text-gray-500 font-heading text-sm rounded-full hover:border-charcoal hover:text-charcoal transition-colors"
            >
              {t("layer.add_panel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
