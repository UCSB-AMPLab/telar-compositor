/**
 * The sync dialog's pages: the pages whose file changed on GitHub
 * (`SyncPageContentBlock`), the page files present on one side only, one
 * card per file, and the pages GitHub added, listed as pre-accepted.
 *
 * A file GitHub alone deleted is a checkbox, taken by default; every other
 * card is a pair of radios, keeping the Compositor's pages by default. A
 * removal names the menu entry it takes with it. An added page is not a
 * choice (R2): its line says whether GitHub's menu gives it an entry.
 *
 * @version v1.5.0-beta
 */

import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { FullSyncDiff } from "~/lib/sync.server";
import type { PageAddition, PageFileChange } from "~/lib/page-content.server";
import {
  listedPageAdditions, listedPageChanges, listedPageFiles, pageChoiceOf, pageFileChoiceOf,
} from "./sync-changes";
import type { ConflictChoice, ThreeWaySelections } from "./sync-changes";
import { ChoiceRadios } from "./SyncConflictsBlock";
import { SyncPageContentBlock } from "./SyncPageContentBlock";

/** Each card's explanation and, for radios, the label of GitHub's side. */
const CARD: Record<PageFileChange["kind"], { text: string; repo: string }> = {
  "deleted": { text: "sync_modal.page_deleted", repo: "sync_modal.page_deleted_take" },
  "deleted-conflict": { text: "sync_modal.page_deleted_conflict", repo: "sync_modal.conflict_delete" },
  "deleted-renamed-here": { text: "sync_modal.page_deleted_renamed_here", repo: "sync_modal.conflict_delete" },
  "not-on-github": { text: "sync_modal.page_not_on_github", repo: "sync_modal.conflict_delete" },
  "edited-renamed-here": { text: "sync_modal.page_edited_renamed_here", repo: "sync_modal.conflict_use_repo" },
  "deleted-here-edited": { text: "sync_modal.conflict_deleted_here", repo: "sync_modal.conflict_restore" },
};

/** The text of a removal the one-language reduction makes, by kind. */
const OTHER_LANGUAGE_TEXT: Partial<Record<PageFileChange["kind"], string>> = {
  "deleted": "sync_modal.page_other_language",
  "deleted-conflict": "sync_modal.page_other_language_conflict",
};

const NOTE_CLASS = "font-body text-xs text-gray-600 mt-1";

interface Props {
  diff: FullSyncDiff | null;
  selections: ThreeWaySelections;
  setSelections: Dispatch<SetStateAction<ThreeWaySelections>>;
}

/** Every page block of the diffReady step. */
export function SyncPagesBlocks({ diff, selections, setSelections }: Props) {
  const setPageChoice = (key: "pageContentChoices" | "pageFileChoices", id: string, choice: ConflictChoice) =>
    setSelections((prev) => ({ ...prev, [key]: { ...prev[key], [id]: choice } }));
  if (!diff) return null;
  return (
    <>
      <SyncPageContentBlock
        changes={listedPageChanges(diff)}
        choiceOf={(change) => pageChoiceOf(change, selections)}
        onChoice={(pageId, choice) => setPageChoice("pageContentChoices", String(pageId), choice)}
      />
      <PageFileCards
        changes={listedPageFiles(diff)}
        choiceOf={(change) => pageFileChoiceOf(change, selections)}
        onChoice={(name, choice) => setPageChoice("pageFileChoices", name, choice)}
      />
      <AddedPages additions={listedPageAdditions(diff)} />
    </>
  );
}

function PageFileCards({ changes, choiceOf, onChoice }: {
  changes: readonly PageFileChange[];
  choiceOf: (change: PageFileChange) => ConflictChoice;
  onChoice: (name: string, choice: ConflictChoice) => void;
}) {
  const { t } = useTranslation("dashboard");
  if (changes.length === 0) return null;
  return (
    <div className="mb-6">
      <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">{t("sync_modal.pages_files_heading")}</h4>
      <p className="font-body text-sm text-gray-600 mb-3">{t("sync_modal.pages_files_intro")}</p>
      <div className="space-y-2">
        {changes.map((change) => (
          <PageFileCard key={change.name} change={change} choice={choiceOf(change)} onChoice={(c) => onChoice(change.name, c)} />
        ))}
      </div>
    </div>
  );
}

function PageFileCard({ change, choice, onChoice }: {
  change: PageFileChange;
  choice: ConflictChoice;
  onChoice: (choice: ConflictChoice) => void;
}) {
  const { t } = useTranslation("dashboard");
  const card = CARD[change.kind];
  const checkbox = change.kind === "deleted";
  const otherLanguageText = change.otherLanguageOf ? OTHER_LANGUAGE_TEXT[change.kind] : undefined;
  return (
    <div data-testid={`page-file-${change.name}`} className={`border rounded-lg px-4 py-3 ${checkbox ? "bg-white border-gray-200" : "bg-amber-50 border-amber-200"}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-body text-sm font-medium text-charcoal">{change.title || t("common:untitled")}</span>
        {!checkbox && (
          <ChoiceRadios
            name={`page-file-${change.name}`}
            choice={choice}
            onChoice={onChoice}
            repoLabel={t(card.repo)}
            mineLabel={t(change.kind === "deleted-here-edited" ? "sync_modal.conflict_keep_deleted" : "sync_modal.conflict_keep_mine")}
          />
        )}
      </div>
      <p className={NOTE_CLASS}>
        {otherLanguageText ? t(otherLanguageText, { file: change.otherLanguageOf }) : t(card.text)}
      </p>
      {checkbox && (
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input type="checkbox" checked={choice === "repo"} onChange={(e) => onChoice(e.target.checked ? "repo" : "d1")} className="accent-terracotta" />
          <span className="font-body text-xs text-charcoal">{t(card.repo)}</span>
        </label>
      )}
      {checkbox && choice === "d1" && <p className={NOTE_CLASS}>{t("sync_modal.page_deleted_keep_note")}</p>}
      <RemovalNotes change={change} />
    </div>
  );
}

/** What a removal takes with it: the page's menu entry. */
function RemovalNotes({ change }: { change: PageFileChange }) {
  const { t } = useTranslation("dashboard");
  return change.inMenu ? <p className={NOTE_CLASS}>{t("sync_modal.page_deleted_menu")}</p> : null;
}

function AddedPages({ additions }: { additions: readonly PageAddition[] }) {
  const { t } = useTranslation("dashboard");
  if (additions.length === 0) return null;
  return (
    <div data-testid="pages-added" className="border border-gray-100 rounded-lg px-4 py-3 mb-4">
      <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">
        {`${t("sync_modal.pages_category")} (${t("sync_modal.section_count", { count: additions.length })})`}
      </h4>
      <ul className="space-y-1">
        {additions.map((a) => (
          <li key={a.name} className="font-body text-sm text-charcoal/80">
            {t("sync_modal.item_new", { name: a.title || a.slug })}
            {a.menu && <p className={NOTE_CLASS}>{t("sync_modal.page_added_menu")}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
