/**
 * StepView — editor panel for a regular story step (1-N).
 *
 * Renders inline-editable question and answer fields that autosave
 * to the steps table via the "autosave-step-field" intent.
 * Layer buttons (up to 2) appear below the answer, styled as pills.
 * Each layer button has a pencil icon to edit the button label inline.
 * Vertically centered within the narrative column.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { Pencil, Check, X, PencilLine } from "lucide-react";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";

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
  };
  layers: LayerData[];
  onOpenLayer: (layer: LayerData) => void;
  onCreateLayer: (stepId: number, layerNumber: number, defaultLabel: string) => void;
  actionUrl: string;
}

/** Inline editor for a layer button label — appears on pencil click. */
function LayerButtonWithEdit({
  layer,
  defaultLabel,
  buttonClassName,
  onOpenLayer,
  actionUrl,
}: {
  layer: LayerData;
  defaultLabel: string;
  buttonClassName: string;
  onOpenLayer: (layer: LayerData) => void;
  actionUrl: string;
}) {
  const { t } = useTranslation("editor");
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(layer.button_label ?? defaultLabel);
  const inputRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher();

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleSave = useCallback(() => {
    setEditing(false);
    const trimmed = label.trim() || defaultLabel;
    setLabel(trimmed);
    fetcher.submit(
      {
        intent: "autosave-layer",
        field: "button_label",
        value: trimmed,
        projectId: String(layer.id),
      },
      { method: "post", action: actionUrl }
    );
  }, [label, defaultLabel, layer.id, actionUrl, fetcher]);

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
          className="px-3 py-1.5 font-heading font-semibold text-sm text-charcoal bg-white border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-periwinkle/50 min-w-[8rem]"
        />
        <button
          type="button"
          onClick={handleSave}
          className="p-1 text-green-600 hover:text-green-700 transition-colors"
          aria-label="Save label"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleCancel}
          className="p-1 text-gray-400 hover:text-charcoal transition-colors"
          aria-label="Cancel editing"
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
        aria-label="Edit button label"
      >
        <Pencil className="w-3 h-3" />
        <span className="font-body text-xs text-gray-400 opacity-0 group-hover/pencil:opacity-100 transition-opacity">
          {t("layer.edit_button_label")}
        </span>
      </button>
    </span>
  );
}

export function StepView({ step, layers, onOpenLayer, onCreateLayer, actionUrl }: StepViewProps) {
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
      <div className="px-6 py-8 border-l-4 border-lavender">
        {/* Question */}
        <div className="group/field relative mb-6" ref={questionRef}>
          <button
            type="button"
            onClick={() => focusField(questionRef)}
            className="absolute -top-5 right-0 flex items-center gap-1 cursor-pointer"
          >
            <span className="font-body text-xs text-gray-400 opacity-0 group-hover/field:opacity-100 transition-opacity">
              {t("step.click_to_edit")}
            </span>
            <PencilLine className="w-3.5 h-3.5 text-gray-300 group-hover/field:text-charcoal transition-colors" />
          </button>
          <InlineTextField
            initialValue={step.question ?? ""}
            fieldName="question"
            entityId={step.id}
            intent="autosave-step-field"
            placeholder={t("step.question_placeholder")}
            inputClassName="font-heading text-xl font-semibold text-charcoal"
          />
        </div>

        {/* Answer */}
        <div className="group/field relative" ref={answerRef}>
          <button
            type="button"
            onClick={() => focusField(answerRef)}
            className="absolute -top-5 right-0 flex items-center gap-1 cursor-pointer"
          >
            <span className="font-body text-xs text-gray-400 opacity-0 group-hover/field:opacity-100 transition-opacity">
              {t("step.click_to_edit")}
            </span>
            <PencilLine className="w-3.5 h-3.5 text-gray-300 group-hover/field:text-charcoal transition-colors" />
          </button>
          <InlineTextArea
            initialValue={step.answer ?? ""}
            fieldName="answer"
            entityId={step.id}
            intent="autosave-step-field"
            placeholder={t("step.answer_placeholder")}
            inputClassName="font-body text-base text-charcoal"
            rows={5}
          />
        </div>

        {/* Layer buttons */}
        <div className="mt-6 flex flex-wrap gap-2">
          {layer1 ? (
            <LayerButtonWithEdit
              layer={layer1}
              defaultLabel={t("layer.default_label_1")}
              buttonClassName="px-5 py-2 bg-lavender/40 text-charcoal font-heading font-semibold text-sm rounded-full hover:bg-lavender/60 transition-colors"
              onOpenLayer={onOpenLayer}
              actionUrl={actionUrl}
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
