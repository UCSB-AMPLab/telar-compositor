/**
 * ValidationChecks — "What we checked" section for the single-page Publish surface.
 *
 * Renders a chilca-pale numbered list of the pre-publish checks that PASSED,
 * followed by any blockers (red) and warnings (amber). `runPrePublishValidation`
 * only emits FAILURES, never a passed-check enumeration — so the passed list is
 * a STATIC canonical set minus the codes whose failures appear in the result.
 *
 * Passed-check ↔ failing-code mapping:
 *   - object_metadata  ← suppressed by an `object_no_title` warning
 *   - term_links       ← no validation code yet (always passes)
 *   - iiif_tiles        ← no validation code yet (always passes)
 *   - site_url          ← no validation code yet (always passes)
 *   - telar_version     ← no validation code yet (always passes)
 * The `stale_head` / `page_no_title` blockers and the `step_no_position` and
 * `renamed_duplicate_column(s)` warnings have no passed-check label; they only
 * render in the failures lists.
 *
 * Warnings whose code appears in WARNING_DOCS_LINKS render through `Trans` so
 * their copy can carry an external docs link; every other warning renders as
 * plain interpolated text. `private_story_workflow_stale` is the one such code.
 *
 * With a `workflowRepair` prop, that same warning also carries the button that
 * repairs the workflow, and the section gains a status line under the warnings
 * block — under, so a successful repair can still say so once the re-run has
 * removed the warning it sat in. That line also follows the rebuild the
 * repair's commit starts, which is followed here and nowhere else.
 *
 * With an `onRemoveColumn` prop, a column blocker carries one button per
 * column it names, which removes that column from every step of the story or
 * every row of the table, once the author has confirmed it. The label keeps
 * the column's own case: `Note` beside `note` is a collision, and an
 * uppercased label would name both the same way.
 *
 * Tailwind token classes only (no hardcoded hex).
 *
 * With an `onResetPageFrontmatter` prop, a page front-matter blocker carries
 * a button that keeps only that page's title in its block.
 *
 * @version v1.5.0-beta
 */

import { cloneElement, useState, type ReactElement } from "react";
import { AlertCircle, AlertTriangle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { RemovableColumns, ValidationItem, ValidationResult } from "~/lib/publish.server";
import { sheetWarningText } from "~/components/ui/SheetWarnings";

/**
 * Where the repair stands. `running` belongs to the button's label; the other
 * settled states belong to the status line.
 */
export type WorkflowRepairStatus =
  | "idle"
  | "running"
  | "done"
  | "permission"
  /** The same refusal as `permission`, for a caller who cannot act on it.
   *  Only the installing account can work the App's settings page, so this
   *  state carries no link and names who can instead. */
  | "permission_convenor_required"
  | "stale"
  | "failed";

/**
 * Where the rebuild the repair's commit started has got to. Null until the
 * repair's own poll has an answer, and for a cancellation this page's own
 * publish already explains.
 */
export interface WorkflowRepairBuild {
  state: "building" | "rebuilt" | "failed" | "cancelled";
  /** The run on GitHub, unknown until GitHub has registered it. */
  buildUrl: string | null;
}

export interface WorkflowRepair {
  status: WorkflowRepairStatus;
  /** Installation settings page for the `permission` status. */
  reauthUrl?: string | null;
  /** Absent wherever no rebuild is being followed. */
  build?: WorkflowRepairBuild | null;
  /** The rebuild's last check could not be made; the poll asks again. */
  buildUnchecked?: boolean;
  onRepair: () => void;
}

interface ValidationChecksProps {
  validation: ValidationResult | null;
  /** Absent wherever the page offers no repair; the checks render unchanged. */
  workflowRepair?: WorkflowRepair;
  /**
   * Keeps only the title in a page's front matter, by slug. Absent wherever
   * the page offers no reset; the blocker then renders without its control.
   */
  onResetPageFrontmatter?: (slug: string) => void;
  /**
   * Removes one column from every step of a story, or every row of a table.
   * Absent wherever the page offers no removal; the column blockers then
   * render without their control.
   */
  onRemoveColumn?: (removable: RemovableColumns, column: string) => void;
  /** The column the last removal could not remove, said above the blockers. */
  removalFailed?: { column: string } | null;
  /** The page the last front-matter reset could not clear, said above the blockers. */
  resetFailed?: { page: string } | null;
  className?: string;
}

/**
 * The reset a page front-matter blocker offers, or nothing for any other
 * blocker or where the page offers no reset.
 */
function PageFrontmatterReset({
  blocker,
  onReset,
  label,
}: {
  blocker: ValidationItem;
  onReset?: (slug: string) => void;
  label: string;
}) {
  if (blocker.code !== "page_frontmatter_unwritable" || !onReset || !blocker.entityId) return null;
  const slug = blocker.entityId;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => onReset(slug)}
        className="inline-flex items-center font-heading font-semibold text-xs bg-terracotta hover:opacity-90 text-cream rounded-full px-4 py-1.5 transition-opacity"
      >
        {label}
      </button>
    </div>
  );
}

/** Where a convenor approves a GitHub App's pending permissions. */
const INSTALLATIONS_SETTINGS_URL = "https://github.com/settings/installations";

/**
 * Canonical passed-check labels, in display order. Each entry names the
 * validation code(s) whose presence (as a blocker OR warning) removes it from
 * the passed list. An empty `suppressedBy` means there is no validation code
 * for that check yet, so it always shows as passed.
 */
const CANONICAL_PASSED_CHECKS: { key: string; suppressedBy: string[] }[] = [
  { key: "object_metadata", suppressedBy: ["object_no_title"] },
  { key: "term_links", suppressedBy: [] },
  { key: "iiif_tiles", suppressedBy: [] },
  { key: "site_url", suppressedBy: [] },
  { key: "telar_version", suppressedBy: [] },
];

/**
 * Warning codes whose copy ends in a `<0>…</0>` segment pointing at the docs
 * page that explains the fix, keyed by UI locale. A code absent from this map
 * renders as plain text, so adding a link is adding an entry here and a `<0>`
 * segment to both locale strings — one without the other renders the markup
 * literally or drops the link.
 *
 * The map belongs to this component: `app/lib/docs-content.ts` is a store of
 * vendored drawer excerpts with one path each, not a link registry.
 */
const WARNING_DOCS_LINKS: Record<string, { en: string; es: string }> = {
  private_story_workflow_stale: {
    en: "https://telar.org/docs/setup/upgrading/#v160-upgrade-notes",
    es: "https://telar.org/guia/configuracion/actualizacion/#notas-de-actualización-a-v160",
  },
};

/**
 * What a settled repair has to say, which is what the rebuild its commit
 * started is doing. The commit carries no skip-CI marker, so that rebuild is
 * the answer to whether the fix worked, and this line is the only place it is
 * shown: the pill and its popovers follow publishes, not repairs.
 *
 * The rebuilt line carries no link — the site itself is the result — while the
 * two ended-badly lines put the run behind their `<0>` segment, which falls
 * back to plain text while GitHub has not named a run.
 */
function WorkflowRepairDoneLine({ build }: { build: WorkflowRepairBuild | null }) {
  const { t } = useTranslation("publish");

  if (!build) {
    return (
      <p className="mt-4 font-body text-sm text-chilca-deep">
        {t("checks.workflow_repair_done")}
      </p>
    );
  }

  if (build.state === "building") {
    return (
      <p className="mt-4 font-body text-sm text-chilca-deep">
        {t("checks.workflow_repair_building")}
        {build.buildUrl ? (
          <>
            {" "}
            <a
              href={build.buildUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-chilca-deep underline hover:text-chilca"
            >
              {t("checks.workflow_repair_watch")}
            </a>
          </>
        ) : null}
      </p>
    );
  }

  if (build.state === "rebuilt") {
    return (
      <p className="mt-4 font-body text-sm text-chilca-deep">
        {t("checks.workflow_repair_rebuilt")}
      </p>
    );
  }

  return (
    <p className="mt-4 font-body text-sm text-terracotta-deep">
      <CatalogueMessage
        text={t(
          build.state === "failed"
            ? "checks.workflow_repair_build_failed"
            : "checks.workflow_repair_build_cancelled",
        )}
        link={
          build.buildUrl ? (
            // eslint-disable-next-line jsx-a11y/anchor-has-content
            <a
              key="run"
              href={build.buildUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-terracotta-deep underline hover:text-terracotta"
            />
          ) : (
            <span key="run" />
          )
        }
      />
    </p>
  );
}

/**
 * What the repair did, rendered at section level rather than inside the
 * warning: a successful repair makes the warning disappear on the re-run, and
 * the line that says so has to survive that.
 */
function WorkflowRepairStatusLine({ repair }: { repair: WorkflowRepair }) {
  const { t } = useTranslation("publish");

  if (repair.status === "idle" || repair.status === "running") return null;

  if (repair.status === "done") {
    return (
      <>
        <WorkflowRepairDoneLine build={repair.build ?? null} />
        {repair.buildUnchecked && (
          <p role="status" className="mt-2 font-body text-sm text-terracotta-deep">
            {t("checks.workflow_repair_build_unchecked")}
          </p>
        )}
      </>
    );
  }

  if (repair.status === "stale") {
    return (
      <div className="mt-4">
        <p className="font-body text-sm text-terracotta-deep">{t("checks.stale_head")}</p>
        <Link
          to="/objects?sync=1"
          className="font-body text-sm text-terracotta underline hover:text-terracotta-deep mt-1 inline-block"
        >
          {t("checks.stale_head_action")}
        </Link>
      </div>
    );
  }

  if (repair.status === "permission") {
    return (
      <p className="mt-4 font-body text-sm text-terracotta-deep">
        <CatalogueMessage
          text={t("checks.workflow_repair_permission")}
          link={
            // eslint-disable-next-line jsx-a11y/anchor-has-content
            <a
              key="settings"
              href={repair.reauthUrl ?? INSTALLATIONS_SETTINGS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-terracotta-deep underline hover:text-terracotta"
            />
          }
        />
      </p>
    );
  }

  if (repair.status === "permission_convenor_required") {
    // No link: the App's settings page can only be worked by the account that
    // installed it, so offering it to anyone else names a remedy they cannot
    // perform. The message names who can instead.
    return (
      <p className="mt-4 font-body text-sm text-terracotta-deep">
        {t("checks.workflow_repair_permission_convenor_required")}
      </p>
    );
  }

  return (
    <p className="mt-4 font-body text-sm text-terracotta-deep">
      {t("checks.workflow_repair_failed")}
    </p>
  );
}

/**
 * What a check's message needs to render: the values i18next is given, and
 * what to put back afterwards.
 */
export interface PreparedMessage {
  values: Record<string, unknown>;
  /** Stand-in text to the authored value it stands in for. */
  real: ReadonlyMap<string, string>;
}

/**
 * Stand-ins for one call's values: a family of placeholders carrying no
 * interpolation syntax of their own and occurring in none of the values they
 * stand for.
 *
 * "None of the values" is checked, not assumed. A value that already contains
 * the stand-in meant for another one would be read as that other value when
 * the text is put back, and an author would see a title nobody wrote. The mark
 * is salted until it appears nowhere in the input, and every stand-in in the
 * family carries the salted mark, so one check covers them all.
 */
function standInsFor(texts: readonly string[]): (index: number) => string {
  let salt = 0;
  while (texts.some((text) => text.includes(`\u0000${salt}v`))) salt += 1;
  return (index) => `\u0000${salt}v${index}\u0000`;
}

/** `text` with every regex metacharacter escaped. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every string in a check's params, including the members of a list. */
function paramTexts(params: Record<string, unknown>): string[] {
  return Object.values(params).flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string"
        ? [value]
        : [],
  );
}

/**
 * The interpolation values a check's message takes, with any kind keys named
 * and any value carrying interpolation syntax stood in for.
 *
 * i18next substitutes a matched placeholder with `String.replace(match, value)`,
 * which finds the FIRST occurrence of that text in the message rather than the
 * one it matched. A story title containing `{{count}}` is therefore the one
 * that receives the count, and the message's own `{{count}}` is left standing
 * for a reader to see. Handing i18next a stand-in instead, and putting the
 * value back afterwards, keeps the collision out of its reach without altering
 * a single character of what an author wrote.
 *
 * A check names the formatting an answer uses by KEY, because it runs on the
 * server with no locale to name it in. The words live in this catalogue, and
 * i18next's `list` formatter joins them with the conjunction the reader's
 * language uses — "lists, headings, and block quotes" against "listas,
 * encabezados y citas" — which a join written here could not do.
 *
 * Not exported: the tests that pin a rendered sentence read it through
 * `checkMessage`, which is the path the page itself takes.
 */
function messageValues(
  params: ValidationItem["params"],
  t: (key: string) => string,
): PreparedMessage {
  if (!params) return { values: {}, real: new Map() };
  const named = Array.isArray(params.kinds)
    ? { ...params, kinds: params.kinds.map((kind) => t(`checks.answer_format_${kind}`)) }
    : params;
  const standIn = standInsFor(paramTexts(named));
  const real = new Map<string, string>();
  // EVERY string is stood in for, whatever it happens to contain. What makes a
  // value dangerous is not its syntax but its authorship: a title carrying
  // `{{count}}` collides with interpolation, one carrying `<0>…</0>` collides
  // with the link the page splits out afterwards, and the next thing a reader
  // of this string looks for is one nobody has thought of yet. Standing every
  // authored string aside means no reader of the translated message can see an
  // author's characters at all. A number passes through untouched, because
  // i18next's plural selection needs a real one. A list's members are judged
  // one by one: an authored column name is as much an author's text as a title.
  const stand = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const mark = standIn(real.size);
    real.set(mark, value);
    return mark;
  };
  const values = Object.fromEntries(
    Object.entries(named).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(stand) : stand(value),
    ]),
  );
  return { values, real };
}

/**
 * `text` with every stand-in replaced by the value it stood for.
 *
 * One pass over the text, matching all of them at once: a value put back can
 * therefore never be read as another stand-in, whatever it contains. Replacing
 * them one after another would scan text already restored, and a value ending
 * in the next stand-in's mark would be consumed by the next round.
 */
function restoreValues(text: string, real: ReadonlyMap<string, string>): string {
  if (real.size === 0) return text;
  const marks = new RegExp([...real.keys()].map(escapeForRegExp).join("|"), "g");
  return text.replace(marks, (mark) => real.get(mark) ?? mark);
}

/** A check's message with its values still stood in for. */
function interpolated(
  t: (key: string, values?: Record<string, unknown>) => string,
  item: ValidationItem,
): { text: string; real: ReadonlyMap<string, string> } {
  const { values, real } = messageValues(item.params, t);
  return { text: t(`checks.${item.code}`, values), real };
}

/**
 * One check's message, rendered as plain interpolated text.
 *
 * Exported so the tests that pin a rendered sentence read the page's own path
 * rather than a copy of it.
 */
export function checkMessage(
  t: (key: string, values?: Record<string, unknown>) => string,
  item: ValidationItem,
): string {
  const { text, real } = interpolated(t, item);
  return restoreValues(text, real);
}

/** A message either side of the one link its catalogue string carries. */
interface LinkedText {
  before: string;
  label: string;
  after: string;
}

/** `<0>…</0>` — the catalogue's own mark for the segment a link wraps. */
const LINK_SEGMENT = /^([\s\S]*)<0>([\s\S]*?)<\/0>([\s\S]*)$/;

/** `text` split around its link segment, or null when it carries none. */
function splitLinkedText(text: string): LinkedText | null {
  const found = LINK_SEGMENT.exec(text);
  return found ? { before: found[1], label: found[2], after: found[3] } : null;
}

/**
 * One check's message, split around the link its copy carries.
 *
 * The split runs on the message while the authored values are still stood in
 * for, and each piece is restored afterwards. That ordering is the point: a
 * story title is an author's text, and a renderer that parses a message as
 * markup reads whatever they typed as markup too — `<img src=x>` became an
 * image, and a typed `<0>…</0>` became a second link to the documentation.
 * Splitting before the values return means the only `<0>` the reader can see
 * is the one the catalogue wrote.
 */
function checkMessageAroundLink(
  t: (key: string, values?: Record<string, unknown>) => string,
  item: ValidationItem,
): LinkedText | null {
  const { text, real } = interpolated(t, item);
  const parts = splitLinkedText(text);
  if (!parts) return null;
  return {
    before: restoreValues(parts.before, real),
    label: restoreValues(parts.label, real),
    after: restoreValues(parts.after, real),
  };
}

/**
 * A message whose link segment is wrapped in `link` and whose every other
 * character is text.
 *
 * One renderer for every message on this page that carries a link, so no
 * message is ever handed to a markup parser.
 */
function WithLink({ parts, link }: { parts: LinkedText; link: ReactElement }) {
  return (
    <>
      {parts.before}
      {cloneElement(link, {}, parts.label)}
      {parts.after}
    </>
  );
}

/**
 * A catalogue string with no authored text in it, rendered around its link.
 *
 * Its whole content is the Compositor's own copy, so there is nothing to stand
 * in for — but it goes through the same splitter as everything else, because a
 * second renderer is a second set of rules about what counts as markup.
 */
function CatalogueMessage({ text, link }: { text: string; link: ReactElement }) {
  const parts = splitLinkedText(text);
  return parts ? <WithLink parts={parts} link={link} /> : <>{text}</>;
}

/**
 * One warning's message: its copy, the values an author wrote, and the docs
 * link its copy carries when it has one.
 */
function WarningMessage({
  t,
  warning,
  href,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
  warning: ValidationItem;
  href?: string;
}) {
  const parts = href === undefined ? null : checkMessageAroundLink(t, warning);
  if (!parts) return <>{checkMessage(t, warning)}</>;
  return (
    <WithLink
      parts={parts}
      link={
        // eslint-disable-next-line jsx-a11y/anchor-has-content
        <a
          key="docs"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-amber-900 underline hover:text-amber-700"
        />
      }
    />
  );
}


/**
 * Says that an action a blocker offered — a story-column removal or a page
 * front-matter reset — did not happen. The blocker it was meant to clear is
 * still in the list below, so without this the click would look as though it
 * had been ignored. The interpolated value is the author's text, so it goes
 * through `checkMessage` like any other.
 */
function ActionFailedLine({
  t,
  code,
  params,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
  code: string;
  params: Record<string, string>;
}) {
  return (
    <p role="alert" className="font-body text-sm text-terracotta-deep mb-2">
      {checkMessage(t, { code, message: code, params })}
    </p>
  );
}

/** Says that a story-column removal the author asked for did not happen. */
function RemovalFailedLine({
  t,
  failure,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
  failure: { column: string } | null | undefined;
}) {
  if (!failure) return null;
  return <ActionFailedLine t={t} code="story_remove_column_failed" params={{ column: failure.column }} />;
}

/** Says that a page front-matter reset the author asked for did not happen. */
function ResetFailedLine({
  t,
  failure,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
  failure: { page: string } | null | undefined;
}) {
  if (!failure) return null;
  return <ActionFailedLine t={t} code="page_frontmatter_reset_failed" params={{ page: failure.page }} />;
}

const REMOVE_LABEL_CODE = {
  steps: "story_remove_column",
  objects: "object_remove_column",
  glossary: "glossary_remove_column",
} as const;

/**
 * One button per column a blocker can remove. A click asks first, naming the
 * column and how many rows hold a value in it, because the values are lost.
 */
function ColumnRemoval({
  t,
  removable,
  onRemove,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
  removable: RemovableColumns;
  onRemove: (removable: RemovableColumns, column: string) => void;
}) {
  const [asked, setAsked] = useState<string | null>(null);
  const buttonClass = "inline-flex items-center font-heading font-semibold text-xs rounded-full px-4 py-1.5 transition-opacity hover:opacity-90";
  if (asked !== null) {
    const confirmed = { code: "column_remove_confirm", message: "column_remove_confirm", params: { column: asked, count: removable.rows[asked] ?? 0 } };
    return (
      <div className="mt-2">
        <p className="font-body text-sm text-terracotta-deep">{checkMessage(t, confirmed)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => { setAsked(null); onRemove(removable, asked); }} className={`${buttonClass} bg-terracotta text-cream`}>
            {t("checks.column_remove_confirm_action")}
          </button>
          <button type="button" onClick={() => setAsked(null)} className={`${buttonClass} border border-terracotta/40 text-terracotta-deep`}>
            {t("checks.column_remove_cancel")}
          </button>
        </div>
      </div>
    );
  }
  const code = REMOVE_LABEL_CODE[removable.table];
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {removable.columns.map((column) => (
        <button key={column} type="button" onClick={() => setAsked(column)} className={`${buttonClass} bg-terracotta text-cream`}>
          {checkMessage(t, { code, message: code, params: { column } })}
        </button>
      ))}
    </div>
  );
}

export function ValidationChecks({
  validation,
  workflowRepair,
  onResetPageFrontmatter,
  onRemoveColumn,
  removalFailed,
  resetFailed,
  className = "",
}: ValidationChecksProps) {
  const { t } = useTranslation("publish");

  // Loading state — validation not yet returned from server.
  if (validation === null) {
    return (
      <div className={`flex items-center gap-2 text-charcoal/60 py-4 ${className}`}>
        <div className="w-5 h-5 rounded-full border-2 border-cream-dark border-t-anil animate-spin flex-shrink-0" />
        <span className="font-body text-sm">{t("checks.heading")}…</span>
      </div>
    );
  }

  const hasBlockers = validation.blockers.length > 0;
  const hasWarnings = validation.warnings.length > 0;

  // Derive passed checks: the canonical set minus any check whose failing code
  // is present in blockers or warnings (validation reports failures only).
  const failingCodes = new Set<string>([
    ...validation.blockers.map((b) => b.code),
    ...validation.warnings.map((w) => w.code),
  ]);
  const passedChecks = CANONICAL_PASSED_CHECKS.filter(
    (check) => !check.suppressedBy.some((code) => failingCodes.has(code)),
  );

  return (
    <div className={className}>
      {passedChecks.length > 0 && (
        <ol className="rounded-lg bg-chilca-pale border border-chilca/20 px-5 py-4 space-y-2 list-none">
          {passedChecks.map((check, idx) => (
            <li key={check.key} className="flex items-start gap-3">
              <span className="font-heading text-xs text-chilca-deep/70 w-4 flex-shrink-0 mt-0.5 tabular-nums">
                {idx + 1}.
              </span>
              <Check className="w-4 h-4 text-chilca-deep flex-shrink-0 mt-0.5" />
              <span className="font-body text-sm text-chilca-deep">
                {t(`passed_checks.${check.key}`)}
              </span>
            </li>
          ))}
        </ol>
      )}

      {hasBlockers && (
        <div className="mt-4">
          <h3 className="font-heading font-semibold text-sm text-terracotta mb-2">
            {t("checks.blockers_heading")}
          </h3>
          <ResetFailedLine t={t} failure={resetFailed} />
          <RemovalFailedLine t={t} failure={removalFailed} />
          <div className="space-y-2">
            {validation.blockers.map((blocker, idx) => (
              <div
                key={`${blocker.code}-${blocker.entityId ?? idx}`}
                className="flex items-start gap-3 bg-terracotta-pale border border-terracotta/20 rounded-lg p-3"
              >
                <AlertCircle className="w-4 h-4 text-terracotta flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-body text-sm text-terracotta-deep">
                    {checkMessage(t, blocker)}
                  </p>
                  {blocker.code === "stale_head" && (
                    <Link
                      to="/objects?sync=1"
                      className="font-body text-sm text-terracotta underline hover:text-terracotta-deep mt-1 inline-block"
                    >
                      {t("checks.stale_head_action")}
                    </Link>
                  )}
                  <PageFrontmatterReset
                    blocker={blocker}
                    onReset={onResetPageFrontmatter}
                    label={t("checks.page_frontmatter_reset")}
                  />
                  {blocker.removable && onRemoveColumn && (
                    <ColumnRemoval t={t} removable={blocker.removable} onRemove={onRemoveColumn} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasWarnings && <ValidationWarnings warnings={validation.warnings} workflowRepair={workflowRepair} />}

      {workflowRepair && <WorkflowRepairStatusLine repair={workflowRepair} />}
    </div>
  );
}

/**
 * The warnings, under their heading, as the checks list them. The Publish
 * section shows the warnings a refused publish returns through it too.
 */
export function ValidationWarnings({
  warnings,
  workflowRepair,
  className = "mt-4",
}: {
  warnings: ValidationItem[];
  workflowRepair?: WorkflowRepair;
  className?: string;
}) {
  const { t, i18n } = useTranslation("publish");
  const { t: tCommon } = useTranslation("common");
  // Same locale rule as DocsDrawer: the compositor's chosen UI language, no
  // per-warning picker.
  const docsLocale: "en" | "es" = i18n.language?.toLowerCase().startsWith("es") ? "es" : "en";
  if (warnings.length === 0) return null;
  return (
    <div className={className}>
      <h3 className="font-heading font-semibold text-sm text-amber-700 mb-2">
        {t("checks.warnings_heading")}
      </h3>
      <div className="space-y-2">
        {warnings.map((warning, idx) => (
          <div
            key={`${warning.code}-${warning.entityId ?? idx}`}
            className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-3"
          >
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-body text-sm text-amber-900">
                {warning.sheetWarning ? (
                  sheetWarningText(tCommon, warning.sheetWarning)
                ) : (
                  <WarningMessage
                    t={t}
                    warning={warning}
                    href={WARNING_DOCS_LINKS[warning.code]?.[docsLocale]}
                  />
                )}
              </p>
              {warning.code === "private_story_workflow_stale" && workflowRepair && (
                <button
                  type="button"
                  onClick={workflowRepair.onRepair}
                  disabled={workflowRepair.status === "running"}
                  className="mt-2 inline-flex items-center font-heading font-semibold text-xs uppercase tracking-wider bg-amber-600 hover:opacity-90 disabled:opacity-60 text-cream rounded-full px-4 py-1.5 transition-opacity"
                >
                  {t(
                    workflowRepair.status === "running"
                      ? "checks.workflow_repair_running"
                      : "checks.workflow_repair_action",
                  )}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
