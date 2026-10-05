/**
 * GlossaryCalloutDialog — chooses the entry and the side of a glossary
 * callout from the Widget menu: the glossary link's entry picker, then
 * right (the framework's default) or left. Insert hands both to the caller,
 * which writes the block.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Dialog } from "~/components/ui/Dialog";
import { GlossaryEntryPicker } from "~/components/ui/markdown-editor/GlossaryEntryPicker";
import type { CalloutSide } from "~/lib/glossary-callout";

const SIDES: CalloutSide[] = ["right", "left"];

function SideChoice({ side, onChange }: { side: CalloutSide; onChange: (side: CalloutSide) => void }) {
  const { t } = useTranslation("editor");
  return (
    <fieldset className="mb-4">
      <legend className="font-body text-sm text-charcoal mb-1">{t("panel.glossarySide")}</legend>
      <div className="flex gap-4">
        {SIDES.map((value) => (
          <label key={value} className="flex items-center gap-2 cursor-pointer font-body text-sm text-charcoal">
            <input type="radio" name="glossary-callout-side" checked={side === value} onChange={() => onChange(value)} />
            {t(value === "right" ? "panel.glossaryRight" : "panel.glossaryLeft")}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function GlossaryCalloutDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (entry: string, side: CalloutSide) => void;
}) {
  const { t } = useTranslation("editor");
  const [entry, setEntry] = useState<string | null>(null);
  const [side, setSide] = useState<CalloutSide>("right");
  const close = () => {
    setEntry(null);
    setSide("right");
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} className="max-w-md p-6">
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">{t("panel.glossary")}</h2>
      <GlossaryEntryPicker selected={entry} onSelect={setEntry} />
      <SideChoice side={side} onChange={setSide} />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={close}
          className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal border border-gray-200 rounded-full px-4 py-2 hover:bg-gray-50 transition-colors"
        >
          {t("common:cancel")}
        </button>
        <button
          type="button"
          disabled={!entry}
          onClick={() => {
            if (entry) onInsert(entry, side);
            close();
          }}
          className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal bg-anil hover:bg-anil-hover rounded-full px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t("panel.glossaryInsert")}
        </button>
      </div>
    </Dialog>
  );
}
