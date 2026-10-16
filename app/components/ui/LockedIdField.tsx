/**
 * An ID shown locked, in the gray box the object page uses, with a Change
 * button beside it for an author who may change it ("Change ID" unless the
 * caller names it). The button opens an editor below the box: the typed text
 * passes through `filterTyped`, so a disallowed character never appears;
 * `problem` says why the candidate cannot be the ID; and a candidate that
 * differs from the current ID shows `consequences` with the confirm button.
 * Escape cancels the editor and Enter confirms when confirming is allowed.
 *
 * The field holds no rule of its own: what an ID may contain, what it may not
 * collide with and what changing it does all arrive as props.
 *
 * @version v1.5.5-beta
 */

import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface LockedIdFieldProps {
  label: string;
  /** The id of the box that shows the ID, for the label. */
  inputId: string;
  /** Text of the Change buttons; "Change ID" when omitted. */
  changeLabel?: string;
  value: string;
  canChange: boolean;
  /** One line under the box: where the ID shows up. */
  addressNote: string;
  /** Applied to the editor's text on every keystroke. */
  filterTyped: (raw: string) => string;
  /** The ID the typed text stands for, which the checks and the confirm use; the text itself when omitted. */
  settle?: (typed: string) => string;
  /** A message when `candidate` cannot be the ID, null when it can. */
  problem: (candidate: string) => string | null;
  /** What changing the ID to `candidate` does, shown before the author confirms. */
  consequences: (candidate: string) => ReactNode;
  onConfirm: (candidate: string) => void;
}

/** The caller's label when it gave one, the field's own otherwise. */
function labelOrDefault(given: string | undefined, fallback: string): string {
  return given ?? fallback;
}

export function LockedIdField({
  label,
  inputId,
  changeLabel,
  value,
  canChange,
  addressNote,
  filterTyped,
  settle = (typed) => typed,
  problem,
  consequences,
  onConfirm,
}: LockedIdFieldProps) {
  const { t } = useTranslation("common");
  const [typed, setTyped] = useState<string | null>(null);
  const noteId = useId();
  const changeText = labelOrDefault(changeLabel, t("change_id"));

  const candidate = typed === null ? null : settle(typed);
  const message = candidate === null ? null : problem(candidate);
  const allowed = candidate !== null && candidate !== value && message === null;

  function closeIdEditor() {
    setTyped(null);
  }

  function confirm() {
    if (candidate === null || !allowed) return;
    onConfirm(candidate);
    closeIdEditor();
  }

  return (
    <div>
      <label htmlFor={inputId} className="block font-body text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <p
          id={inputId}
          className="flex-1 min-w-0 font-mono text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
          title={value}
        >
          {value}
        </p>
        {canChange && typed === null && (
          <button
            type="button"
            onClick={() => setTyped(value)}
            className="shrink-0 font-heading font-semibold text-xs uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-4 py-2 hover:bg-cream transition-colors"
          >
            {changeText}
          </button>
        )}
      </div>
      <p id={noteId} className="font-body text-xs text-gray-400 mt-1">
        {addressNote}
      </p>
      {typed !== null && (
        <div className="mt-3">
          <input
            type="text"
            value={typed}
            autoFocus
            aria-label={label}
            aria-describedby={noteId}
            aria-invalid={message !== null || undefined}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setTyped(filterTyped(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeIdEditor();
              } else if (e.key === "Enter") {
                e.preventDefault();
                confirm();
              }
            }}
            className="block w-full font-mono text-sm text-charcoal rounded-md border border-gray-200 px-3 py-2 bg-white hover:border-gray-300 focus:border-anil"
          />
          {message !== null && (
            <p role="alert" className="mt-2 font-body text-xs text-terracotta">
              {message}
            </p>
          )}
          {allowed && (
            <div role="group" className="mt-3 rounded-md bg-qolle-pale text-qolle-deep px-4 py-3">
              <div className="font-body text-sm mb-3 space-y-2">{consequences(candidate!)}</div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={confirm}
                  className="font-heading font-semibold text-xs uppercase tracking-wider text-charcoal bg-anil hover:bg-anil-hover rounded-full px-3.5 py-1.5 transition-colors"
                >
                  {changeText}
                </button>
                <button
                  type="button"
                  onClick={closeIdEditor}
                  className="font-heading font-semibold text-xs uppercase tracking-wider text-qolle-deep border border-qolle-deep/30 rounded-full px-3.5 py-1.5 hover:bg-qolle-deep/10 transition-colors"
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}
          {!allowed && (
            <button
              type="button"
              onClick={closeIdEditor}
              className="mt-2 font-heading font-semibold text-xs uppercase tracking-wider text-gray-500 hover:text-charcoal transition-colors"
            >
              {t("cancel")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
