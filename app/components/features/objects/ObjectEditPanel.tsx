/**
 * ObjectEditPanel — slide-out right panel for editing object metadata.
 *
 * Receives the selected object as a prop; the parent route owns all data
 * fetching and persistence via callbacks. This keeps the component
 * presentation-only and testable in isolation.
 *
 * Sections:
 *   1. Thumbnail preview (200px or Package icon placeholder)
 *   2. Identification — Object ID (read-only), Title (required), Description
 *   3. Metadata — Creator, Period, Year, Object Type, Subjects, Source, Credit
 *   4. Source info (read-only) — Source URL, IIIF tiles badge, Featured toggle
 *   5. Sticky action bar — Save (primary pill) + Cancel (outline pill)
 *
 * Keyboard: Escape closes the panel.
 * Validation: title is required; if actionError is "title_required" the
 *   title input gets a red border and the i18n error message is shown.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Package } from "lucide-react";
import { Switch } from "~/components/ui/Switch";
import { Button } from "~/components/ui/Button";
import type { InferSelectModel } from "drizzle-orm";
import type { objects } from "~/db/schema";

type ObjectRow = InferSelectModel<typeof objects>;

interface ObjectEditPanelProps {
  /** The object being edited, or null when the panel is closed. */
  object: ObjectRow | null;
  /** Controls whether the panel is visible. */
  open: boolean;
  /** Called when the user closes the panel (X button, Cancel, or Escape). */
  onClose: () => void;
  /**
   * Called when the user submits the form. Receives the native FormData so
   * the parent route can submit it via its own fetcher.
   */
  onSave: (formData: FormData) => void;
  /** Shows a loading spinner on the Save button while the action is in flight. */
  isSaving: boolean;
  /**
   * Server-side validation error key returned by the route action.
   * "title_required" shows a red border and error message under the title input.
   */
  actionError: string | null;
}

// ---------------------------------------------------------------------------
// Section heading helper
// ---------------------------------------------------------------------------

function SectionHeading({ label }: { label: string }) {
  return (
    <p className="font-heading font-semibold text-xs uppercase tracking-wider text-gray-500 mb-3 pb-2 border-b border-gray-100">
      {label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Field label helper
// ---------------------------------------------------------------------------

function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block font-body text-xs font-medium text-gray-600 mb-1"
    >
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Input / textarea shared classes
// ---------------------------------------------------------------------------

const inputBase =
  "w-full font-body text-sm text-charcoal border rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-periwinkle focus:border-transparent transition-colors";

const inputNormal = `${inputBase} border-gray-200`;
const inputError = `${inputBase} border-red-400 ring-1 ring-red-400`;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ObjectEditPanel({
  object,
  open,
  onClose,
  onSave,
  isSaving,
  actionError,
}: ObjectEditPanelProps) {
  const { t } = useTranslation("objects");
  const formRef = useRef<HTMLFormElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Focus title input when panel opens
  useEffect(() => {
    if (open && titleInputRef.current) {
      setTimeout(() => titleInputRef.current?.focus(), 210);
    }
  }, [open, object?.id]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;

    // Client-side title validation
    const titleValue = (form.elements.namedItem("title") as HTMLInputElement)?.value?.trim();
    if (!titleValue) {
      titleInputRef.current?.focus();
      return;
    }

    onSave(new FormData(form));
  }

  const titleError = actionError === "title_required";
  const hasThumbnail = Boolean(object?.thumbnail);
  const sourceUrl = object?.source_url;

  // Request a higher-resolution thumbnail for the panel preview.
  // IIIF Image API URLs use the pattern: .../full/{size}/0/default.jpg
  // Replace the size segment with a larger value for the 420px-wide panel.
  const panelThumbnail = object?.thumbnail
    ? object.thumbnail.replace(/\/![0-9]+,[0-9]+\//, "/!800,400/")
    : null;

  return (
    <>
      {/* Backdrop (mobile only — hidden lg+) */}
      {open && (
        <div
          className="fixed inset-0 bg-black/20 z-30 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel */}
      <aside
        aria-label={t("edit_title")}
        className={`
          fixed right-0 top-0 h-full w-[420px] bg-white shadow-xl z-40
          flex flex-col
          transform transition-transform duration-200
          ${open ? "translate-x-0" : "translate-x-full"}
        `}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="font-heading font-semibold text-base text-charcoal truncate pr-4">
            {object?.title || t("edit_title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("discard_button")}
            className="p-1.5 rounded-lg text-gray-400 hover:text-charcoal hover:bg-gray-100 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 p-6">
          {object && (
            <form
              ref={formRef}
              id="edit-object-form"
              method="post"
              onSubmit={handleSubmit}
            >
              {/* Hidden intents */}
              <input type="hidden" name="intent" value="update-object" />
              <input type="hidden" name="objectDbId" value={object.id} />

              {/* ── Thumbnail preview ──────────────────────────────────── */}
              <div className="mb-6">
                {hasThumbnail ? (
                  <img
                    src={panelThumbnail ?? object.thumbnail!}
                    alt={object.title ?? t("edit_title")}
                    className="w-full max-h-[280px] object-contain rounded-lg bg-gray-100"
                  />
                ) : (
                  <div className="w-full h-[200px] rounded-lg bg-gray-100 flex items-center justify-center">
                    <Package className="w-12 h-12 text-gray-300" />
                  </div>
                )}
              </div>

              {/* ── Identification ─────────────────────────────────────── */}
              <div className="mb-6">
                <SectionHeading label={t("section_required")} />

                {/* Object ID — read-only */}
                <div className="mb-4">
                  <FieldLabel htmlFor="object-id-display">
                    {/* reuse "breadcrumb_objects" key since there's no dedicated
                        "object_id" key — show a descriptive label instead */}
                    Object ID
                  </FieldLabel>
                  <p
                    id="object-id-display"
                    className="font-mono text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
                    title={object.object_id}
                  >
                    {object.object_id}
                  </p>
                </div>

                {/* Title — required */}
                <div className="mb-4">
                  <FieldLabel htmlFor="field-title" required>
                    {t("field_title")}
                  </FieldLabel>
                  <input
                    ref={titleInputRef}
                    id="field-title"
                    name="title"
                    type="text"
                    required
                    defaultValue={object.title ?? ""}
                    className={titleError ? inputError : inputNormal}
                    placeholder={t("field_title")}
                  />
                  {titleError && (
                    <p className="mt-1 text-xs text-red-500 font-body">
                      {t("field_title_required")}
                    </p>
                  )}
                </div>

                {/* Description — optional */}
                <div className="mb-4">
                  <FieldLabel htmlFor="field-description">
                    {t("field_description")}
                  </FieldLabel>
                  <textarea
                    id="field-description"
                    name="description"
                    rows={3}
                    defaultValue={object.description ?? ""}
                    className={`${inputNormal} resize-none`}
                    placeholder={t("field_description")}
                  />
                </div>
              </div>

              {/* ── Metadata ───────────────────────────────────────────── */}
              <div className="mb-6">
                <SectionHeading label={t("section_optional")} />

                {/* Creator */}
                <div className="mb-4">
                  <FieldLabel htmlFor="field-creator">
                    {t("field_creator")}
                  </FieldLabel>
                  <input
                    id="field-creator"
                    name="creator"
                    type="text"
                    defaultValue={object.creator ?? ""}
                    className={inputNormal}
                    placeholder={t("field_creator")}
                  />
                </div>

                {/* Period + Year — 2-column grid */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <FieldLabel htmlFor="field-period">
                      {t("field_period")}
                    </FieldLabel>
                    <input
                      id="field-period"
                      name="period"
                      type="text"
                      defaultValue={object.period ?? ""}
                      className={inputNormal}
                      placeholder={t("field_period")}
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="field-year">
                      {t("field_year")}
                    </FieldLabel>
                    <input
                      id="field-year"
                      name="year"
                      type="text"
                      defaultValue={object.year ?? ""}
                      className={inputNormal}
                      placeholder={t("field_year")}
                    />
                  </div>
                </div>

                {/* Object Type */}
                <div className="mb-4">
                  <FieldLabel htmlFor="field-object-type">
                    {t("field_object_type")}
                  </FieldLabel>
                  <input
                    id="field-object-type"
                    name="object_type"
                    type="text"
                    defaultValue={object.object_type ?? ""}
                    className={inputNormal}
                    placeholder={t("field_object_type")}
                  />
                </div>

                {/* Subjects */}
                <div className="mb-4">
                  <FieldLabel htmlFor="field-subjects">
                    {t("field_subjects")}
                  </FieldLabel>
                  <input
                    id="field-subjects"
                    name="subjects"
                    type="text"
                    defaultValue={object.subjects ?? ""}
                    className={inputNormal}
                    placeholder={t("field_subjects")}
                  />
                </div>

                {/* Source */}
                <div className="mb-4">
                  <FieldLabel htmlFor="field-source">
                    {t("field_source")}
                  </FieldLabel>
                  <input
                    id="field-source"
                    name="source"
                    type="text"
                    defaultValue={object.source ?? ""}
                    className={inputNormal}
                    placeholder={t("field_source")}
                  />
                </div>

                {/* Credit */}
                <div className="mb-4">
                  <FieldLabel htmlFor="field-credit">
                    {t("field_credit")}
                  </FieldLabel>
                  <input
                    id="field-credit"
                    name="credit"
                    type="text"
                    defaultValue={object.credit ?? ""}
                    className={inputNormal}
                    placeholder={t("field_credit")}
                  />
                </div>
              </div>

              {/* ── Source info (read-only) ─────────────────────────────── */}
              <div className="mb-6">
                <SectionHeading label={t("section_readonly")} />

                {/* Source URL */}
                <div className="mb-4">
                  <p className="font-body text-xs font-medium text-gray-600 mb-1">
                    {t("field_source_url")}
                  </p>
                  {sourceUrl ? (
                    <p
                      className="font-body text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
                      title={sourceUrl}
                    >
                      {sourceUrl}
                    </p>
                  ) : (
                    <p className="font-body text-sm text-gray-400 italic">
                      None
                    </p>
                  )}
                </div>

                {/* IIIF tiles status */}
                <div className="mb-4">
                  <p className="font-body text-xs font-medium text-gray-600 mb-1">
                    {t("field_image_available")}
                  </p>
                  {object.image_available ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-body font-medium bg-green-50 text-green-700 rounded-full px-2.5 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      Available
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs font-body font-medium bg-gray-100 text-gray-500 rounded-full px-2.5 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                      Not available
                    </span>
                  )}
                </div>

                {/* Featured toggle — included in form so parent can handle it */}
                <div className="flex items-center justify-between">
                  <p className="font-body text-xs font-medium text-gray-600">
                    {t("field_featured")}
                  </p>
                  {/* Hidden input carries the featured value; Switch updates it */}
                  <FeaturedToggle defaultChecked={object.featured ?? false} />
                </div>
              </div>
            </form>
          )}
        </div>

        {/* Sticky action bar */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-3 flex gap-3 shrink-0">
          <Button
            type="submit"
            form="edit-object-form"
            variant="primary"
            loading={isSaving}
            disabled={isSaving}
            className="flex-1"
          >
            {t("save_button")}
          </Button>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="
              flex-1 font-heading font-semibold text-sm uppercase tracking-wider
              border border-gray-200 text-charcoal rounded-full px-6 py-2.5
              hover:bg-cream transition-colors disabled:opacity-50
            "
          >
            {t("discard_button")}
          </button>
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// FeaturedToggle — local helper that manages a hidden input alongside Switch
// ---------------------------------------------------------------------------

function FeaturedToggle({ defaultChecked }: { defaultChecked: boolean }) {
  const { t } = useTranslation("objects");
  // Use a controlled pattern via React state so the hidden input stays in sync
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <div className="flex items-center gap-2">
      <input type="hidden" name="featured" value={checked ? "true" : "false"} />
      <Switch
        checked={checked}
        onChange={setChecked}
        label={checked ? t("unmark_featured") : t("mark_featured")}
      />
    </div>
  );
}
