/**
 * The review dialog's changes, one card each (`sync-items.ts`): a kind label,
 * the item's name, a badge for a change made in both places or one with no
 * version chosen, a line saying what happened, and its versions as radios,
 * each with a note on what the next publish does. Above them, "Set all to";
 * below, the notices that carry no choice (files with characters that cannot
 * be read among them) and the "When you apply" box.
 * Presentational: the modal owns the choices.
 *
 * @version v1.5.5-beta
 */

import { useId, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { configFieldLabel } from "~/lib/activity-display";
import { listOf } from "~/lib/page-language-names";
import type { ConflictChoice, ThreeWaySelections } from "./sync-changes";
import {
  choiceOfItem,
  setAllTo,
  type ApplySummary,
  type ItemKind,
  type Named,
  type PublishAction,
  type SummaryAction,
  type SyncItem,
  type SyncNotices,
} from "./sync-items";
import { reasonText } from "./SyncStoryContentBlock";

type T = TFunction<"dashboard"> | ((key: string, options?: Record<string, unknown>) => string);

/** The name the dialog gives an item: its own key's text, a setting by its label, anything else as listed. */
export function displayName(named: Named, t: T): string {
  if (named.nameKey) return t(named.nameKey);
  if (named.kind === "setting") return configFieldLabel(named.name, t as never) || t("sync_modal.config_setting");
  return named.name;
}

const KIND_LABEL: Record<ItemKind, string> = {
  object: "sync_modal.review.kind_object",
  image: "sync_modal.review.kind_image",
  story: "sync_modal.review.kind_story",
  setting: "sync_modal.review.kind_setting",
  term: "sync_modal.review.kind_term",
  page: "sync_modal.review.kind_page",
};

const BADGE_CLASS = "font-heading font-semibold text-[10px] uppercase tracking-wider bg-amber-100 text-amber-900 rounded-full px-2 py-0.5";

function ItemCard({ item, choice, onChoice }: {
  item: SyncItem;
  choice: ConflictChoice | null;
  onChoice: (choice: ConflictChoice) => void;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const id = useId();
  const fields = item.fields ? listOf(item.fields.map((f) => t(f)), i18n?.language) : undefined;
  const why = item.reason ? reasonText(t as TFunction<"dashboard">, item.reason) : null;
  const marked = item.both || item.defaultChoice === null;
  return (
    <div
      data-testid={`sync-item-${item.key}`}
      className={`border rounded-lg px-4 py-3 ${marked ? "bg-white border-amber-300 border-l-4" : "bg-white border-gray-200"}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-1">
        <span className="font-heading text-[11px] uppercase tracking-wider text-gray-500">{t(KIND_LABEL[item.kind])}</span>
        <span className="font-heading font-semibold text-sm text-charcoal">{item.title ?? (item.titleKey ? t(item.titleKey) : displayName(item, t) || t("common:untitled"))}</span>
        {item.both ? (
          <span className={BADGE_CLASS}>{t("sync_modal.review.badge_both")}</span>
        ) : item.defaultChoice === null ? (
          <span className={BADGE_CLASS}>{t("sync_modal.review.badge_choose")}</span>
        ) : null}
      </div>
      <p className="font-body text-sm text-gray-700 mb-1">
        {t(item.what.key, { ...item.what.values, ...(fields !== undefined ? { fields } : {}) })}
      </p>
      {why && <p className="font-body text-xs text-gray-500 mb-1">{why}</p>}
      {item.details.map((line) => (
        <p key={line.key} className="font-body text-xs text-gray-500 mb-1">{t(line.key, line.values)}</p>
      ))}
      <div className="mt-2 space-y-2">
        {item.options.map((option) => (
          <div key={option.choice} className="flex items-start gap-2">
            <input
              id={`${id}-${option.choice}`}
              type="radio"
              name={id}
              value={option.choice}
              checked={choice === option.choice}
              onChange={() => onChoice(option.choice)}
              aria-describedby={option.note ? `${id}-${option.choice}-note` : undefined}
              className="accent-terracotta mt-1 cursor-pointer"
            />
            <div>
              <label htmlFor={`${id}-${option.choice}`} className="block font-body text-sm text-charcoal cursor-pointer">
                {t(option.label)}
              </label>
              {option.note && (
                <p id={`${id}-${option.choice}-note`} className="font-body text-xs text-gray-500">{t(option.note, option.noteValues)}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SET_ALL_CLASS = "font-body text-xs text-terracotta underline hover:text-terracotta/80";

/** "Set all to", then a card per item. */
export function SyncItemCards({ items, selections, setSelections }: {
  items: readonly SyncItem[];
  selections: ThreeWaySelections;
  setSelections: Dispatch<SetStateAction<ThreeWaySelections>>;
}) {
  const { t } = useTranslation("dashboard");
  if (items.length === 0) return null;
  const choosable = items.some((item) => item.options.length > 1);
  return (
    <div className="mb-4">
      {choosable && (
        <p className="font-body text-xs text-gray-600 mb-3">
          {t("sync_modal.review.set_all")}{" "}
          <button type="button" className={SET_ALL_CLASS} onClick={() => setSelections((prev) => setAllTo(items, prev, "repo"))}>
            {t("sync_modal.review.set_all_gh")}
          </button>
          {" · "}
          <button type="button" className={SET_ALL_CLASS} onClick={() => setSelections((prev) => setAllTo(items, prev, "d1"))}>
            {t("sync_modal.review.set_all_comp")}
          </button>
        </p>
      )}
      <div className="space-y-2">
        {items.map((item) => (
          <ItemCard
            key={item.key}
            item={item}
            choice={choiceOfItem(item, selections)}
            onChoice={(choice) => setSelections((prev) => item.write(prev, choice))}
          />
        ))}
      </div>
    </div>
  );
}

const NOTICE_LINE = "font-body text-sm text-gray-700";

/**
 * What the review shows with no choice: the changes every accept applies
 * (GitHub's object order, Telar version and added pages), and the files with
 * characters that cannot be read that no item offers a choice on.
 */
export function SyncNoticesBlock({ notices }: { notices: SyncNotices }) {
  const { t } = useTranslation("dashboard");
  const pages = notices.addedPages;
  const files = notices.unreadableFiles;
  if (!notices.objectOrder && !notices.version && pages.length === 0 && files.length === 0) return null;
  return (
    <div data-testid="sync-notices" className="border border-gray-100 rounded-lg px-4 py-3 mb-4 space-y-1">
      {files.map(({ file, effect }) => (
        <p key={`unreadable-${file}`} data-testid="unreadable-notice" className={NOTICE_LINE}>
          {t(`common:sheet_warnings.unreadable_characters.${effect}`, { file })}
        </p>
      ))}
      {notices.objectOrder && <p className={NOTICE_LINE}>{t("objects:sync_order_changed")}</p>}
      {notices.version && <p className={NOTICE_LINE}>{t("sync_modal.review.notice_version", { version: notices.version })}</p>}
      {pages.length > 0 && (
        <div data-testid="pages-added">
          <p className={NOTICE_LINE}>{t("sync_modal.review.notice_pages_added", { count: pages.length })}</p>
          <ul className="list-disc pl-5">
            {pages.map((page, index) => (
              <li key={`${index}-${page.name}`} className={NOTICE_LINE}>
                {page.name}
                {page.menu && <span className="block font-body text-xs text-gray-500">{t("sync_modal.page_added_menu")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The phrase for each action in the Compositor's sentence. */
const COMPOSITOR_PHRASE: Record<SummaryAction, string> = {
  take: "sync_modal.review.act_take",
  keep: "sync_modal.review.act_keep",
  add: "sync_modal.review.act_add",
  skip: "sync_modal.review.act_skip",
  restore: "sync_modal.review.act_restore",
  stay_deleted: "sync_modal.review.act_stay_deleted",
  delete: "sync_modal.review.act_delete",
  keep_present: "sync_modal.review.act_keep_present",
  order: "sync_modal.review.act_order",
  version: "sync_modal.review.act_version",
};

/** The phrase for each action in the next publish's sentence. */
const PUBLISH_PHRASE: Record<PublishAction, string> = {
  overwrite: "sync_modal.review.pub_overwrite",
  restore: "sync_modal.review.pub_restore",
  add: "sync_modal.review.pub_add",
  repair: "sync_modal.review.pub_repair",
};

/** The "When you apply" sentences for `summary`. */
export function applySentences(summary: ApplySummary, t: T, language: string | undefined): string[] {
  if (summary.kind === "pending") {
    const key = summary.allBoth ? "sync_modal.review.pending_both" : summary.allStories ? "sync_modal.review.pending_stories" : "sync_modal.review.pending";
    return [t(key, { count: summary.count })];
  }
  if (summary.compositor.length === 0) return [];
  const phrase = (key: string, names: readonly Named[]) => {
    const shown = names.map((n) => displayName(n, t));
    return t(key, { names: listOf(shown, language), count: shown.length, version: summary.version ?? "" });
  };
  const sentences = [t("sync_modal.review.compositor_does", {
    actions: listOf(summary.compositor.map((g) => phrase(COMPOSITOR_PHRASE[g.action], g.names)), language),
  })];
  if (summary.publish.length > 0) {
    sentences.push(t("sync_modal.review.publish_does", {
      actions: listOf(summary.publish.map((g) => phrase(PUBLISH_PHRASE[g.action], g.names)), language),
    }));
  }
  return sentences;
}

export function WhenYouApply({ summary }: { summary: ApplySummary }) {
  const { t, i18n } = useTranslation("dashboard");
  return (
    <div data-testid="when-you-apply" className="bg-lavender/40 rounded-lg px-4 py-3 mb-2">
      <p className="font-heading font-semibold text-xs uppercase tracking-wider text-charcoal mb-1">{t("sync_modal.review.when_apply")}</p>
      <p className="font-body text-sm text-charcoal">{applySentences(summary, t, i18n?.language).join(" ")}</p>
    </div>
  );
}
