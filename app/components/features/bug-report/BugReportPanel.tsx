/**
 * This file is the modal panel that orchestrates the bug-report
 * form, the auto-captured payload disclosure, and the
 * GitHub-redirect submit.
 *
 *  - 480px max-width, max-h 80vh, role="dialog", Escape closes, Tab
 *    traps, initial focus on the first textarea, focus returns to
 *    triggerRef on close.
 *  - Three textareas (required-≥10 / optional-≤500 / optional-≤1000),
 *    then the optional recent-changes checkboxes.
 *  - Submit calls window.open(url, "_blank", "noopener,noreferrer")
 *    then showToast then onClose.
 *  - In mode="post-crash": panel intro and first-field label switch,
 *    and a captured boundary error is rendered pinned + unremovable
 *    in the AttachmentList.
 *  - The repository is pinned: the issue body writes it whatever the
 *    reporter removes.
 *  - The repository's current name on GitHub is read when the panel
 *    opens and attached only when it differs from the stored one; the
 *    panel never waits for it.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bug, X } from "lucide-react";
import { useToast } from "~/hooks/use-toast";
import { useEscapeToClose } from "~/hooks/use-escape-to-close";
import {
  buildIssueBody,
  type FormInput,
  type Payload,
  type RecentChange,
} from "./build-issue-body";
import { buildIssueUrl, deriveIssueTitle } from "./build-issue-url";
import { getRecentErrors, type CapturedError } from "~/lib/error-capture";
import { getLastPublishFailure } from "~/lib/publish-failure-capture";
import { AttachmentList } from "./AttachmentList";
import { buildAttachmentItems } from "./attachment-items";
import { RecentChangesField } from "./RecentChangesField";
import { useCurrentRepoName } from "./use-current-repo-name";

/** What the `_app` loader knows about the active site, for the report. */
export interface ReportSite {
  /** Active project's GitHub repo ("owner/name"). Omitted when there's no
   * active project (e.g. some post-crash contexts). */
  repoFullName?: string;
  /** The site's `telar_version` as the Compositor holds it. */
  telarVersion?: string;
  /** True when the repository has commits the Compositor didn't make. */
  headDiverged?: boolean;
  /** The project the report is about. Binds the name read and the last
   * failed publish to this site. */
  projectId?: number;
}

interface BugReportPanelProps {
  open: boolean;
  onClose: () => void;
  mode: "default" | "post-crash";
  /** GitHub login for the "signed in as @x" caption. Empty
   * string suppresses the line entirely so the post-crash flow doesn't show
   * a dangling "@". */
  userLogin: string;
  /** Active project's GitHub repo ("owner/name"), captured in the report so we
   * know which site/install it came from. Omitted when there's no active
   * project (e.g. some post-crash contexts). */
  repoFullName?: string;
  /** The site's `telar_version`, when the loader has one. */
  telarVersion?: string;
  /** True when the repository has commits the Compositor didn't make. */
  headDiverged?: boolean;
  /** The project the report is about, when there is one. */
  projectId?: number;
  /** When set (post-crash mode), the captured boundary error rendered pinned
   * + unremovable. */
  pinnedError?: CapturedError | null;
  /** Optional ref to the trigger button — focus returns here on close. */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

/**
 * buildPayload — snapshot the runtime context for inclusion in the issue body.
 * Called once at panel-open time.
 */
export function buildPayload(site: ReportSite = {}): Payload {
  const { repoFullName, telarVersion, headDiverged, projectId } = site;
  const failure = getLastPublishFailure(projectId);
  const lastPublishFailure = failure
    ? { error: failure.error, at: failure.at }
    : undefined;
  const env =
    typeof document !== "undefined"
      ? (document.documentElement.dataset.env ?? "dev")
      : "dev";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return {
    url:
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "",
    ...(repoFullName ? { repoFullName } : {}),
    buildSha: __BUILD_SHA__,
    environment: env,
    browser: parseUa(ua),
    viewport:
      typeof window !== "undefined"
        ? `${window.innerWidth} × ${window.innerHeight}`
        : "",
    locale:
      typeof document !== "undefined"
        ? document.documentElement.lang || "en"
        : "en",
    timestamp: new Date().toISOString(),
    errors: getRecentErrors(),
    ...(telarVersion ? { telarVersion } : {}),
    ...(headDiverged ? { headDiverged: true as const } : {}),
    ...(lastPublishFailure ? { lastPublishFailure } : {}),
  };
}

function parseUa(ua: string): string {
  const browserMatch = ua.match(/(Firefox|Edg|Chrome|Safari)\/([\d.]+)/);
  const osMatch =
    ua.match(/Mac OS X ([\d_]+)/) ||
    ua.match(/Windows NT ([\d.]+)/) ||
    ua.match(/Android (\d+)/) ||
    ua.match(/(iPhone|iPad) OS ([\d_]+)/);
  if (!browserMatch) return ua || "unknown";
  const browser = browserMatch[1].replace("Edg", "Edge");
  const version = browserMatch[2].split(".")[0];
  let os = "unknown OS";
  if (osMatch) {
    if (osMatch[0].startsWith("Mac")) {
      os = `macOS ${osMatch[1].split("_").slice(0, 2).join(".")}`;
    } else if (osMatch[0].startsWith("Windows")) {
      os = `Windows ${osMatch[1]}`;
    } else if (osMatch[0].startsWith("Android")) {
      os = `Android ${osMatch[1]}`;
    } else {
      os = `iOS ${(osMatch[2] ?? "").replace(/_/g, ".")}`;
    }
  }
  return `${browser} ${version} on ${os}`;
}

export function BugReportPanel({
  open,
  onClose,
  mode,
  userLogin,
  repoFullName,
  telarVersion,
  headDiverged,
  projectId,
  pinnedError,
  triggerRef,
}: BugReportPanelProps) {
  const { t } = useTranslation("bug-report");
  const { showToast } = useToast();
  const [whatHappened, setWhatHappened] = useState("");
  const [expected, setExpected] = useState("");
  const [steps, setSteps] = useState("");
  const [recentChanges, setRecentChanges] = useState<RecentChange[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const firstInputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const snapshot = useMemo<Payload | null>(
    () =>
      open
        ? buildPayload({ repoFullName, telarVersion, headDiverged, projectId })
        : null,
    [open, repoFullName, telarVersion, headDiverged, projectId],
  );
  const githubFullName = useCurrentRepoName(open, projectId, repoFullName);
  const payload = useMemo<Payload | null>(
    () => (snapshot && githubFullName ? { ...snapshot, githubFullName } : snapshot),
    [snapshot, githubFullName],
  );

  // Escape closes.
  useEscapeToClose((e) => {
    e.preventDefault();
    onClose();
  }, open);

  // Initial focus on first textarea.
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() =>
        firstInputRef.current?.focus(),
      );
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  // Focus return to trigger on close.
  useEffect(() => {
    if (!open && triggerRef?.current) {
      const raf = requestAnimationFrame(() => triggerRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open, triggerRef]);

  if (!open) return null;

  const trimmedWhat = whatHappened.trim();
  const isValid =
    trimmedWhat.length >= 10 &&
    expected.length <= 500 &&
    steps.length <= 1000;

  function toggleRemoved(key: string) {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Tab/Shift-Tab cycle (focus trap).
  function handleKeyDownTrap(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables?.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function handleSubmit() {
    if (!isValid || !payload) return;
    const form: FormInput = {
      whatHappened: trimmedWhat,
      expected: expected.trim(),
      steps: steps.trim(),
      recentChanges,
    };
    const body = buildIssueBody(form, payload, removed, mode);
    const url = buildIssueUrl(body, deriveIssueTitle(trimmedWhat));
    window.open(url, "_blank", "noopener,noreferrer");
    showToast({ type: "info", message: t("submit_toast") });
    onClose();
  }

  const items = buildAttachmentItems(payload, pinnedError, t);

  const intro =
    mode === "post-crash" ? t("crash_panel_intro") : t("panel_intro");
  const whatLabel =
    mode === "post-crash"
      ? t("crash_field_what_label")
      : t("field_what_happened_label");
  const title =
    mode === "post-crash" ? t("crash_title") : t("panel_title");

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bug-report-title"
      onKeyDown={handleKeyDownTrap}
    >
      <div
        ref={panelRef}
        className="bg-white rounded-lg shadow-xl max-w-[480px] w-full mx-4 p-6 max-h-[80vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between mb-3">
          <h3
            id="bug-report-title"
            className="font-heading text-lg font-semibold text-charcoal flex items-center gap-2"
          >
            <Bug className="w-5 h-5" aria-hidden /> {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("panel_close_aria")}
            className="text-gray-400 hover:text-charcoal"
          >
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>

        <p className="font-body text-sm text-charcoal mb-4">{intro}</p>

        <label
          className="block font-heading text-sm text-charcoal"
          htmlFor="bug-what-happened"
        >
          {whatLabel}
          <span aria-hidden> *</span>
        </label>
        <textarea
          ref={firstInputRef}
          id="bug-what-happened"
          aria-label={whatLabel}
          value={whatHappened}
          onChange={(e) => setWhatHappened(e.target.value)}
          placeholder={t("field_what_happened_placeholder")}
          required
          rows={3}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-body text-sm"
        />
        <p className="text-xs text-gray-500 mt-1">
          {t("field_what_happened_why")}
        </p>

        <label
          className="block font-heading text-sm text-charcoal mt-4"
          htmlFor="bug-expected"
        >
          {t("field_expected_label")}
        </label>
        <textarea
          id="bug-expected"
          aria-label={t("field_expected_label")}
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder={t("field_expected_placeholder")}
          maxLength={500}
          rows={2}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-body text-sm"
        />
        <p className="text-xs text-gray-500 mt-1">
          {t("field_expected_why")}
        </p>

        <label
          className="block font-heading text-sm text-charcoal mt-4"
          htmlFor="bug-steps"
        >
          {t("field_steps_label")}
        </label>
        <textarea
          id="bug-steps"
          aria-label={t("field_steps_label")}
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          placeholder={t("field_steps_placeholder")}
          maxLength={1000}
          rows={3}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-body text-sm"
        />
        <p className="text-xs text-gray-500 mt-1">{t("field_steps_why")}</p>

        <RecentChangesField
          selected={recentChanges}
          onChange={setRecentChanges}
        />

        <div className="mt-4">
          <AttachmentList
            items={items}
            removed={removed}
            onRemove={toggleRemoved}
          />
          {pinnedError && (
            <p className="text-xs text-gray-500 mt-1">
              {t("crash_pinned_error_note")}
            </p>
          )}
        </div>

        {userLogin && (
          <p className="text-xs text-gray-500 mt-4">
            {t("submit_signed_in_as", { login: userLogin })}
          </p>
        )}

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isValid}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-white bg-terracotta hover:bg-terracotta/90 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {t("submit_button")} →
          </button>
        </div>
      </div>
    </div>
  );
}
