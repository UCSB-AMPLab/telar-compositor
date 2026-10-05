/**
 * The object page's Change ID dialog.
 *
 * The ID field is prefilled with the object's ID. The dialog judges the typed
 * value as the action does, against the rows the page loaded
 * (`renameIdRefusal`), and offers its one confirm button only for a value the
 * action could accept. It says what the change does: the steps it updates,
 * the steps that show another row or no object today and show this one
 * afterwards, the steps that keep their value inside a collision, the steps
 * the new ID takes over, the shared image kept for both rows, the text
 * references, and the page's new address.
 *
 * The form posts the ID the page showed (`shownObjectId`), so the action
 * refuses a rename of an object whose ID has changed since. An answer is read
 * once, and only when it is this dialog's own, for this object. On success the
 * page moves to the object's new address, keeping its query; when the
 * Compositor half is still owed (`pending`), the dialog says so and stays. A
 * refusal is named in the dialog. A site reading Google Sheets is offered the
 * switch, which posts the same form with `disableSheets`.
 *
 * The form also posts what the dialog says about the steps
 * (`renameFactsFingerprint`). When the repository disagrees with the page's
 * rows, the action answers with the facts it found instead of renaming; the
 * dialog then shows those facts, says the counts were updated, and posts
 * them on the next confirm.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useFetcher, useNavigate } from "react-router";
import {
  RENAME_ID_PATTERN,
  renameFactsFingerprint,
  renameIdRefusal,
  stepsTakenOverBy,
  type ObjectRenameFacts,
  type RenameIdRefusal,
} from "~/lib/object-rename-id";
import { REPO_WRITE_REFUSAL_KEYS } from "~/lib/repo-write-refusal-keys";

/** What the `rename-object` action answers. */
export type RenameAnswer =
  | {
      ok: true;
      intent: "rename-object";
      objectDbId: number;
      newId: string;
      pending: boolean;
      committed: boolean;
      dispatchRunId: number | null;
    }
  | { ok: false; intent: "rename-object"; objectDbId: number; error: string; params?: Record<string, string> }
  | { ok: false; intent: "rename-object"; objectDbId: number; error: "rename_facts_changed"; facts: ObjectRenameFacts };

/** What the dialog does with one answer. */
export type RenameOutcome =
  | { kind: "ignore" }
  | { kind: "leave"; newId: string }
  | { kind: "pending" }
  | { kind: "sheets" }
  | { kind: "changed"; facts: ObjectRenameFacts }
  | { kind: "message"; key: string; params?: Record<string, string> };

/** Refusal codes whose message key is the code itself. */
const OWN_KEY_CODES = new Set([
  "rename_taken",
  "rename_site_taken",
  "rename_file_exists",
  "rename_stale_head",
  "rename_operation_in_progress",
  "rename_failed",
  "rename_cache_unreachable",
  "rename_unregistered_files",
  "rename_unchanged",
  "rename_sheets_not_disableable",
  "rename_id_unreadable",
  "rename_too_many_files",
  "rename_stale_object",
  "course_item_rename_refused",
]);

/** The `objects` message for a refusal code; an unknown code reads as a failure. */
export function renameRefusalKey(error: string): string {
  if (error === "invalid_id") return "upload_error_invalid_id";
  if (error === "forbidden") return "rename_forbidden";
  if (OWN_KEY_CODES.has(error)) return error;
  return REPO_WRITE_REFUSAL_KEYS.get(error) ?? "rename_failed";
}

/** Reads one fetcher answer for the object `objectDbId`; another intent's or object's is ignored. */
export function readRenameAnswer(answer: unknown, objectDbId: number): RenameOutcome {
  const a = answer as Partial<RenameAnswer> | null | undefined;
  if (!a || a.intent !== "rename-object" || a.objectDbId !== objectDbId) return { kind: "ignore" };
  const read = a as RenameAnswer;
  if (read.ok) return read.pending ? { kind: "pending" } : { kind: "leave", newId: read.newId };
  if (read.error === "rename_sheets_on") return { kind: "sheets" };
  if ("facts" in read) return { kind: "changed", facts: read.facts };
  return { kind: "message", key: renameRefusalKey(read.error), params: read.params };
}

/** What is wrong with a typed ID before it is posted, or null; the unchanged ID is not a problem, only not a change. */
function typedIdProblem(value: string, objectId: string, facts: ObjectRenameFacts): RenameIdRefusal | null {
  if (value === objectId) return null;
  if (!RENAME_ID_PATTERN.test(value)) return { error: "invalid_id" };
  return renameIdRefusal(value, facts.otherIds, facts.version);
}

interface ObjectRenameDialogProps {
  objectDbId: number;
  objectId: string;
  facts: ObjectRenameFacts;
  onClose: () => void;
}

export function ObjectRenameDialog({ objectDbId, objectId, facts: loadedFacts, onClose }: ObjectRenameDialogProps) {
  const { t } = useTranslation("objects");
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [value, setValue] = useState(objectId);
  const [outcome, setOutcome] = useState<RenameOutcome>({ kind: "ignore" });
  const [facts, setFacts] = useState(loadedFacts);
  const handled = useRef<unknown>(null);

  useEffect(() => {
    const answer = fetcher.data;
    if (!answer || handled.current === answer) return;
    const read = readRenameAnswer(answer, objectDbId);
    if (read.kind === "ignore") return;
    handled.current = answer;
    if (read.kind === "leave") {
      navigate(`/objects/${encodeURIComponent(read.newId)}${window.location.search}`);
      return;
    }
    if (read.kind === "changed") setFacts(read.facts);
    setOutcome(read);
  }, [fetcher.data, navigate, objectDbId]);

  const busy = fetcher.state !== "idle";
  const unchanged = value === objectId;
  const problem = typedIdProblem(value, objectId, facts);
  const done = outcome.kind === "pending";

  function edit(next: string) {
    setValue(next);
    if (outcome.kind !== "pending") setOutcome({ kind: "ignore" });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div role="dialog" aria-labelledby="rename-title" className="bg-white rounded-xl shadow-lg p-6 max-w-md w-full mx-4">
        <h3 id="rename-title" className="font-heading font-semibold text-lg text-charcoal mb-2">
          {t("rename_title")}
        </h3>
        <p className="font-body text-sm text-gray-600 mb-4">{t("rename_description")}</p>
        <label htmlFor="rename-new-id" className="block font-body text-xs font-medium text-gray-600 mb-1">
          {t("upload_object_id")}
        </label>
        <input
          id="rename-new-id"
          value={value}
          onChange={(event) => edit(event.target.value)}
          disabled={busy || done}
          className="w-full font-mono text-sm text-charcoal border border-gray-200 rounded-lg px-3 py-2 mb-1"
        />
        {problem && (
          <p className="font-body text-xs text-red-600 mb-2">{t(renameRefusalKey(problem.error), problem.params)}</p>
        )}
        <RenameConsequences facts={facts} newId={unchanged || problem !== null ? null : value} />
        <RenameOutcomeLine outcome={outcome} />
        <div className="flex flex-col gap-2">
          {!done && (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="rename-object" />
              <input type="hidden" name="objectDbId" value={objectDbId} />
              <input type="hidden" name="shownObjectId" value={objectId} />
              <input type="hidden" name="newId" value={value} />
              <input type="hidden" name="confirmedFacts" value={renameFactsFingerprint(facts, value)} />
              {outcome.kind === "sheets" && <input type="hidden" name="disableSheets" value="true" />}
              <button
                type="submit"
                disabled={busy || unchanged || problem !== null}
                className="w-full font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-white rounded-full px-6 py-2.5 transition-colors disabled:bg-disabled disabled:text-fg-disabled"
              >
                {t(confirmLabelKey(busy, outcome))}
              </button>
            </fetcher.Form>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors disabled:text-fg-disabled"
          >
            {t(done ? "common:close" : "common:cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The confirm button's label: working, the Sheets switch once offered, or the plain change. */
function confirmLabelKey(busy: boolean, outcome: RenameOutcome): string {
  if (busy) return "rename_working";
  return outcome.kind === "sheets" ? "rename_sheets_confirm" : "rename_confirm";
}

/**
 * What the change does: the steps it updates, the steps that show another row
 * or no object today and this one afterwards, the steps that keep their value
 * inside a collision, the steps a valid `newId` takes over, the shared image
 * or the text references, and the page's new address.
 */
function RenameConsequences({ facts, newId }: { facts: ObjectRenameFacts; newId: string | null }) {
  const { t } = useTranslation("objects");
  const taken = newId === null ? 0 : stepsTakenOverBy(newId, facts.unresolvedStepValues, facts.version);
  return (
    <ul className="font-body text-sm text-gray-600 space-y-1.5 my-4 list-disc pl-5">
      {facts.stepsRewritten > 0 && <li>{t("rename_steps", { count: facts.stepsRewritten })}</li>}
      {facts.stepsTakenOver > 0 && (
        <li>{t("rename_steps_switched", { count: facts.stepsTakenOver, shown: facts.takenOverFrom.join(", ") })}</li>
      )}
      {facts.stepsGained > 0 && <li>{t("rename_steps_gained", { count: facts.stepsGained })}</li>}
      {facts.stepsKept > 0 && facts.shared && (
        <li>{t("rename_steps_kept", { count: facts.stepsKept, after: facts.shared.after })}</li>
      )}
      {taken > 0 && <li>{t("rename_steps_taken_over", { count: taken, id: newId })}</li>}
      <li>{facts.shared ? t("rename_shared_image", { others: facts.shared.others.join(", ") }) : t("rename_texts")}</li>
      <li>{t("rename_page_address")}</li>
    </ul>
  );
}

/** The line an answer leaves in the dialog: a refusal, the Sheets offer, the updated facts, or the pending note. */
function RenameOutcomeLine({ outcome }: { outcome: RenameOutcome }) {
  const { t } = useTranslation("objects");
  if (outcome.kind === "message") {
    return (
      <p className="font-body text-sm text-red-600 mb-4">
        {t(outcome.key, outcome.params)}
        {outcome.key === "repo_write_upgrade_required" && (
          <>
            {" "}
            <Link to="/upgrade?from=/objects" className="text-blue-600 hover:underline">
              {t("upload_upgrade_link")}
            </Link>
          </>
        )}
      </p>
    );
  }
  if (outcome.kind === "changed") return <p className="font-body text-sm text-amber-700 mb-4">{t("rename_facts_changed")}</p>;
  if (outcome.kind === "sheets") return <p className="font-body text-sm text-amber-700 mb-4">{t("rename_sheets_on")}</p>;
  if (outcome.kind === "pending") return <p className="font-body text-sm text-gray-700 mb-4">{t("rename_document_pending")}</p>;
  return null;
}
