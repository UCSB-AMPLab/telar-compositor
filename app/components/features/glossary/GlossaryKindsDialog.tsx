/**
 * The site's own glossary kinds, edited as one list and saved to the
 * glossary route's `save-kinds` action. The standard kinds come from the
 * site's files and are shown, not edited. The server refuses a list holding
 * any kind the framework would leave out, so the same check runs here first
 * and its findings show under each field.
 *
 * Everything is read once, when the dialog opens: the kinds, the stored text
 * the save names as the list it replaces, and the entries' kinds the counts
 * are taken from. A kind that was in the list carries its id at opening as
 * `from`, which is how the server reports a changed id; after a save, every
 * entry of a renamed kind is moved to its new id in the document.
 *
 * @version v1.5.1-beta
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { Dialog } from "~/components/ui/Dialog";
import { Button } from "~/components/ui/Button";
import { useSiteFetcher } from "~/lib/page-site";
import { useIsPublisher } from "~/hooks/use-role";
import { useToast } from "~/hooks/use-toast";
import {
  isAcceptedKind,
  validateSiteKinds,
  type GlossaryKinds,
  type KindProblem,
  type SiteKindDraft,
  type SiteKindProblems,
} from "~/lib/glossary-kinds";
import { useKindName } from "~/components/features/glossary/GlossaryKindSelect";
import { countEntriesByKind, glossaryEntryKinds, renameEntryKinds } from "~/lib/glossary-kind-entries";

type Field = "id" | "label" | "heading" | "values";
const FIELDS: Field[] = ["id", "label", "heading", "values"];
const FIELD_TEXT: Record<Field, { label: string; help: string }> = {
  id: { label: "kind_field_id", help: "kind_field_id_help" },
  label: { label: "kind_field_label", help: "kind_field_label_help" },
  heading: { label: "kind_field_heading", help: "kind_field_heading_help" },
  values: { label: "kind_field_values", help: "kind_field_values_help" },
};

/** A site kind as the dialog edits it: its other names as one comma-separated text. */
interface KindRow {
  key: string;
  /** The kind's id when the dialog opened; none for a kind added here. */
  from?: string;
  id: string;
  label: string;
  heading: string;
  values: string;
  /** The values as read, sent as they are while `values` still shows them: a value may hold a comma. */
  listed?: string[];
  /** What keeps the kind out of the site as the repository writes it. */
  repoProblem?: KindProblem;
}

type SaveAnswer =
  | { ok: true; stored: string; renamed: Record<string, string> }
  | { ok: false; message?: string };

const splitValues = (text: string): string[] => text.split(",").map((v) => v.trim()).filter(Boolean);

function rowOf(kind: SiteKindDraft, index: number): KindRow {
  return {
    key: `site-${index}`,
    from: kind.id || undefined,
    id: kind.id,
    label: kind.label,
    heading: kind.heading,
    values: kind.values.join(", "),
    listed: kind.values,
    repoProblem: Object.values(kind.problems)[0],
  };
}

function rowValues(row: KindRow): string[] {
  return row.listed !== undefined && row.values === row.listed.join(", ") ? row.listed : splitValues(row.values);
}

function kindPayload(row: KindRow) {
  const kind = { id: row.id.trim(), label: row.label.trim(), heading: row.heading.trim(), values: rowValues(row) };
  return row.from === undefined ? kind : { ...kind, from: row.from };
}

/** The "Edit kinds" button beside the Kind label: only where the site has kinds, and only for a role that may save them. */
export function EditKindsButton({ kinds, onClick }: { kinds: GlossaryKinds; onClick: () => void }) {
  const { t } = useTranslation("glossary");
  const canSave = useIsPublisher();
  if (!kinds.available || !canSave) return null;
  return (
    <button type="button" onClick={onClick} className="font-body text-xs text-terracotta hover:text-terracotta/80 underline">
      {t("kinds_edit")}
    </button>
  );
}

interface GlossaryKindsDialogProps {
  open: boolean;
  onClose: () => void;
  kinds: GlossaryKinds;
  /**
   * The stored kinds column as the page read it; null while the config is
   * their source, and then the save names `kinds.repoSite`, the config's kinds
   * the page showed.
   */
  stored: string | null;
  ydoc: Y.Doc | null;
}

export function GlossaryKindsDialog({ open, onClose, ...rest }: GlossaryKindsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <KindsEditor onClose={onClose} {...rest} />
    </Dialog>
  );
}

/**
 * A problem names the kind that holds a value by the label validation read,
 * which for a standard kind is the site's. The dialog lists standard kinds in
 * the interface language, so the problem names them the same way.
 */
const KindNameByLabel = createContext<(label: string) => string>((label) => label);

function problemText(
  t: (key: string, vars?: Record<string, unknown>) => string,
  problem: KindProblem,
  nameByLabel: (label: string) => string,
): string {
  return t(problem.key, { value: problem.value, kind: problem.kind === undefined ? undefined : nameByLabel(problem.kind) });
}

function StandardKinds({ kinds }: { kinds: GlossaryKinds }) {
  const { t } = useTranslation("glossary");
  const name = useKindName(kinds);
  const core = kinds.core;
  return (
    <section className="mt-4">
      <h3 className="font-heading text-sm font-semibold text-charcoal">{t("kinds_standard_heading")}</h3>
      <ul className="mt-2 space-y-1">
        {core.map((kind) => (
          <li key={kind.id} className="font-body text-sm text-charcoal">
            <span className="font-mono text-xs">{kind.id}</span> · {name(kind)}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface KindFieldProps {
  field: Field;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}

function KindField({ field, value, error, onChange, onBlur }: KindFieldProps) {
  const { t } = useTranslation("glossary");
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block font-heading text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1">
        {t(FIELD_TEXT[field].label)}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="font-body text-sm text-charcoal bg-surface rounded-md border border-gray-200 px-2.5 py-1.5 w-full"
      />
      <p id={`${id}-help`} className="mt-1 font-body text-xs text-fg-muted">{t(FIELD_TEXT[field].help)}</p>
      {error && <p className="mt-1 font-body text-xs text-terracotta">{error}</p>}
    </div>
  );
}

interface RemoveConfirmProps {
  label: string;
  count: number;
  defaultLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function RemoveConfirm({ label, count, defaultLabel, onConfirm, onCancel }: RemoveConfirmProps) {
  const { t } = useTranslation("glossary");
  const text = count > 0
    ? t("kind_remove_confirm", { label, count, default: defaultLabel })
    : t("kind_remove_confirm_none", { label });
  return (
    <div role="alert" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="font-body text-sm text-charcoal">{text}</p>
      <div className="mt-2 flex gap-2">
        <Button variant="control" onClick={onConfirm}>{t("kinds_remove")}</Button>
        <Button variant="control" onClick={onCancel}>{t("common:cancel")}</Button>
      </div>
    </div>
  );
}

interface SiteKindRowProps {
  row: KindRow;
  problems: SiteKindProblems;
  shown: (field: Field) => boolean;
  count: number;
  defaultLabel: string;
  onChange: (field: Field, value: string) => void;
  onBlur: (field: Field) => void;
  onRemove: () => void;
}

function RowNotes({ row, count }: { row: KindRow; count: number }) {
  const { t } = useTranslation("glossary");
  const nameByLabel = useContext(KindNameByLabel);
  const renamed = row.from !== undefined && row.id.trim() !== row.from;
  return (
    <>
      {row.repoProblem && (
        <p className="font-body text-xs text-terracotta">
          {t("kind_unusable_in_repo", { problem: problemText(t, row.repoProblem, nameByLabel) })}
        </p>
      )}
      {count > 0 && <p className="font-body text-xs text-fg-muted">{t("kind_entries_using", { count })}</p>}
      {renamed && count > 0 && <p className="font-body text-xs text-charcoal">{t("kind_id_change_note")}</p>}
    </>
  );
}

function SiteKindRow({ row, problems, shown, count, defaultLabel, onChange, onBlur, onRemove }: SiteKindRowProps) {
  const { t } = useTranslation("glossary");
  const [confirming, setConfirming] = useState(false);
  const nameByLabel = useContext(KindNameByLabel);
  const errorOf = (field: Field) => {
    const problem = problems[field];
    return problem && shown(field) ? problemText(t, problem, nameByLabel) : undefined;
  };
  return (
    <li className="rounded-lg border border-gray-200 p-3 space-y-2" data-testid="site-kind">
      <RowNotes row={row} count={count} />
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <KindField
            key={field}
            field={field}
            value={row[field]}
            error={errorOf(field)}
            onChange={(value) => onChange(field, value)}
            onBlur={() => onBlur(field)}
          />
        ))}
      </div>
      {confirming ? (
        <RemoveConfirm label={row.label || row.id} count={count} defaultLabel={defaultLabel} onConfirm={onRemove} onCancel={() => setConfirming(false)} />
      ) : (
        <Button variant="control" onClick={() => setConfirming(true)}>{t("kinds_remove")}</Button>
      )}
    </li>
  );
}

/** The draft list, what each field's check finds, and which findings are shown. */
function useKindRows(kinds: GlossaryKinds) {
  const [rows, setRows] = useState<KindRow[]>(() => kinds.site.map(rowOf));
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const added = useRef(0);
  const payload = useMemo(() => rows.map(kindPayload), [rows]);
  const problems = useMemo(() => validateSiteKinds(kinds.core, payload), [kinds.core, payload]);
  const editField = (key: string, field: Field, value: string) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const touch = (key: string, field: Field) => setTouched((prev) => new Set(prev).add(`${key}:${field}`));
  const removeKind = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));
  const add = () => {
    added.current += 1;
    setRows((prev) => [...prev, { key: `new-${added.current}`, id: "", label: "", heading: "", values: "" }]);
  };
  const shownFor = (key: string) => (field: Field) => showAll || touched.has(`${key}:${field}`);
  return { rows, payload, problems, editField, touch, removeKind, add, shownFor, revealAll: () => setShowAll(true) };
}

type EditorProps = Omit<GlossaryKindsDialogProps, "open">;

/** Applies a save's answer once: a saved list moves renamed entries and closes; a refusal is shown. */
function useSaveAnswer(answer: SaveAnswer | undefined, onSaved: (renamed: Record<string, string>) => void) {
  const [failure, setFailure] = useState<string | null>(null);
  const handled = useRef<SaveAnswer | undefined>(undefined);
  useEffect(() => {
    if (!answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok) onSaved(answer.renamed);
    else setFailure(answer.message === "kinds_conflict" ? "kinds_conflict" : "kinds_save_failed");
  }, [answer, onSaved]);
  return { failure, clearFailure: () => setFailure(null) };
}

/** The save's fields: the list, and the text it replaces, stored or as the repository wrote it. */
function saveForm(payload: unknown[], stored: string | null, seenRepo: string | undefined): Record<string, string> {
  const form: Record<string, string> = { intent: "save-kinds", kinds: JSON.stringify(payload) };
  if (stored !== null) form.base = stored;
  else if (seenRepo !== undefined) form.seenRepo = seenRepo;
  return form;
}

function KindsEditor({ onClose, kinds: current, stored: currentStored, ydoc }: EditorProps) {
  const { t } = useTranslation("glossary");
  const { showToast } = useToast();
  const [{ kinds, stored }] = useState({ kinds: current, stored: currentStored });
  const [counts] = useState(() => countEntriesByKind(kinds, glossaryEntryKinds(ydoc)));
  const draft = useKindRows(kinds);
  const fetcher = useSiteFetcher<SaveAnswer>();
  const onSaved = (renamed: Record<string, string>) => {
    if (ydoc) renameEntryKinds(ydoc, kinds, renamed);
    showToast({ type: "info", message: t("kinds_saved") });
    onClose();
  };
  const { failure, clearFailure } = useSaveAnswer(fetcher.state === "idle" ? fetcher.data : undefined, onSaved);
  const defaultLabel = kinds.options.find((o) => o.id === kinds.defaultId)?.label ?? kinds.defaultId;

  const submitKinds = () => {
    draft.revealAll();
    clearFailure();
    if (!draft.problems.every(isAcceptedKind)) return;
    fetcher.submit(saveForm(draft.payload, stored, kinds.repoSite), { method: "post" });
  };

  const kindName = useKindName(kinds);
  const nameByLabel = (label: string) => {
    const standard = kinds.core.find((kind) => kind.label === label);
    return standard ? kindName(standard) : label;
  };

  return (
    <KindNameByLabel.Provider value={nameByLabel}>
    <div>
      <h2 className="font-heading text-lg font-semibold text-charcoal">{t("kinds_title")}</h2>
      <p className="mt-2 font-body text-sm text-fg-muted">{t("kinds_intro")}</p>
      <StandardKinds kinds={kinds} />
      <section className="mt-6">
        <h3 className="font-heading text-sm font-semibold text-charcoal">{t("kinds_site_heading")}</h3>
        {draft.rows.length === 0 && <p className="mt-2 font-body text-sm text-fg-muted">{t("kinds_none")}</p>}
        <ul className="mt-2 space-y-3">
          {draft.rows.map((row, i) => (
            <SiteKindRow
              key={row.key}
              row={row}
              problems={draft.problems[i] ?? {}}
              shown={draft.shownFor(row.key)}
              count={row.from === undefined ? 0 : (counts.get(row.from) ?? 0)}
              defaultLabel={defaultLabel}
              onChange={(field, value) => draft.editField(row.key, field, value)}
              onBlur={(field) => draft.touch(row.key, field)}
              onRemove={() => draft.removeKind(row.key)}
            />
          ))}
        </ul>
        <Button variant="control" className="mt-3" onClick={draft.add}>{t("kinds_add")}</Button>
      </section>
      {failure && <p role="alert" className="mt-4 font-body text-sm text-terracotta">{t(failure)}</p>}
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>{t("common:close")}</Button>
        <Button onClick={submitKinds} loading={fetcher.state !== "idle"}>{t("kinds_save")}</Button>
      </div>
    </div>
    </KindNameByLabel.Provider>
  );
}
