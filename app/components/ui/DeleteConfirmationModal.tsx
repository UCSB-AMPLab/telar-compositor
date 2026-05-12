/**
 * This file renders the shared confirmation modal for structural
 * delete operations across every entity type the editor surfaces
 * (stories, steps, layers, pages, objects, glossary terms,
 * projects, account).
 *
 * Shows:
 *   - Entity label ("Delete Step 3?") or undo variant
 *     ("Undo add?")
 *   - Optional content summary ("2 layers, 450 words")
 *   - Optional contributor warning ("Contains edits by María,
 *     Carlos") when other team members have edited the item —
 *     uses authorship data from member contributions
 *   - Optional type-to-confirm input gating the destructive
 *     button (for the convenor delete-project and
 *     delete-account flows)
 *   - Destructive confirm button (red by default; terracotta when
 *     the caller passes `destructiveColor="terracotta"`), grey
 *     Cancel
 *
 * Closes on Escape or backdrop click. On open, focus is moved to
 * the Cancel button as the safer default — UNLESS `confirmText` is
 * set, in which case focus moves to the type-to-confirm input so
 * the user can start typing immediately.
 *
 * @version v1.2.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type DeletableEntityType =
  | "story"
  | "step"
  | "layer"
  | "page"
  | "object"
  | "glossary_term"
  | "project"
  | "account";

export interface DeleteConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  entityType: DeletableEntityType;
  /** Human-readable label for the entity, e.g. "Step 3" or "The Battle of Boyacá". */
  entityLabel: string;
  /** Optional summary of content being deleted, e.g. "2 layers, 450 words". */
  contentSummary?: string;
  /** Names of other contributors whose edits will be lost. */
  contributors?: string[];
  /**
   * When true, the modal confirms undoing an add rather than deleting.
   * Title and body copy change accordingly.
   */
  isUndoConfirmation?: boolean;
  /**
   * When set, render a type-to-confirm input. Confirm
   * button stays disabled until the input value strictly equals
   * `confirmText` (case-sensitive, no trim). When unset, no input
   * appears (back-compat for existing structural callers).
   */
  confirmText?: string;
  /**
   * Destructive button colour. Default `"red"` preserves
   * back-compat with all existing structural callers; `"terracotta"`
   * is used by the delete-project flow on /account where terracotta
   * matches the brand-destructive register.
   */
  destructiveColor?: "red" | "terracotta";
  /**
   * Optional title override. When set,
   * replaces the default `t("delete_confirm_title", { label })` string
   * — used by the delete-project / leave-project flows where the
   * project title needs richer rendering (e.g. ES `«…»` quotation
   * marks) than the generic "Delete {{label}}?" pattern. Back-compat:
   * undefined keeps the existing structural behaviour.
   */
  titleOverride?: string;
  /**
   * Optional body copy rendered as a
   * paragraph immediately under the title. Used by the delete-project
   * and leave-project flows to surface their context-specific copy
   * (e.g. "This permanently removes the project from the
   * compositor. Your GitHub repository (owner/repo) is not touched.").
   * Existing structural callers pass nothing and continue to render
   * the same modal body as before.
   */
  bodyText?: string;
  /**
   * Optional instruction line shown
   * directly above the type-to-confirm input. Replaces the default
   * `Type {{value}} to confirm.` structural string when set. The
   * substitution is up to the caller (e.g. so ES can render
   * `Escribe **{title}** para confirmar.`).
   */
  typeInstructionOverride?: React.ReactNode;
  /**
   * Optional confirm button label
   * override. Default = `t("btn_delete")` from the structural
   * namespace; the delete-project + leave-project flows pass their
   * own ("Delete project" / "Leave project").
   */
  confirmLabel?: string;
}

export function DeleteConfirmationModal({
  open,
  onClose,
  onConfirm,
  entityType: _entityType,
  entityLabel,
  contentSummary,
  contributors,
  isUndoConfirmation = false,
  confirmText,
  destructiveColor = "red",
  titleOverride,
  bodyText,
  typeInstructionOverride,
  confirmLabel: confirmLabelOverride,
}: DeleteConfirmationModalProps) {
  const { t } = useTranslation("structural");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = useState("");

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Reset the typed value on every open transition (false → true).
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  // Focus management:
  //   - confirmText set → focus the input (so the user can type immediately)
  //   - otherwise → focus Cancel (safer default for accidental Enter)
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      if (confirmText) {
        inputRef.current?.focus();
      } else {
        cancelRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, confirmText]);

  if (!open) return null;

  const hasContributors = (contributors?.length ?? 0) > 0;
  const title =
    titleOverride ??
    (isUndoConfirmation
      ? t("delete_confirm_undo_title")
      : t("delete_confirm_title", { label: entityLabel }));
  const confirmLabel =
    confirmLabelOverride ??
    (isUndoConfirmation ? t("btn_undo_confirm") : t("btn_delete"));
  const confirmDisabled = !!confirmText && typed !== confirmText;

  const destructiveBgClass =
    destructiveColor === "terracotta"
      ? "bg-terracotta hover:bg-terracotta/90"
      : "bg-red-600 hover:bg-red-700";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3
          id="delete-confirm-title"
          className="font-heading text-lg font-semibold text-charcoal"
        >
          {title}
        </h3>

        {isUndoConfirmation && (
          <p className="font-body text-sm text-gray-600 mt-2">
            {t("delete_confirm_undo_body")}
          </p>
        )}

        {/* Optional bodyText (delete-project / leave-project) */}
        {bodyText && (
          <p className="font-body text-sm text-gray-600 mt-2 whitespace-pre-line">
            {bodyText}
          </p>
        )}

        {contentSummary && (
          <p className="font-body text-sm text-gray-600 mt-2">
            {t("content_summary", { summary: contentSummary })}
          </p>
        )}

        {hasContributors && (
          <p className="font-body text-sm text-amber-700 bg-amber-50 rounded px-3 py-2 mt-3">
            {t("contributor_warning", {
              names: (contributors ?? []).join(", "),
            })}
          </p>
        )}

        {confirmText && (
          <div className="mt-4">
            <label className="block">
              <span className="font-body text-sm text-charcoal">
                {typeInstructionOverride ??
                  t("type_to_confirm_label", {
                    defaultValue: "Type {{value}} to confirm.",
                    value: confirmText,
                  })}
              </span>
              <input
                ref={inputRef}
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-body text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-terracotta/40"
                aria-label={t("type_to_confirm_aria", {
                  defaultValue: "Type {{value}} to confirm",
                  value: confirmText,
                })}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
        )}

        <div className="flex gap-3 justify-end mt-6">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-charcoal bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t("btn_cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-white ${destructiveBgClass} transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
