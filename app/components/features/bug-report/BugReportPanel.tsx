/**
 * This file is the modal panel that orchestrates the bug-report
 * form, the auto-captured payload disclosure, and the
 * GitHub-redirect submit.
 *
 *  - 480px max-width, max-h 80vh, role="dialog", Escape closes, Tab
 *    traps, initial focus on the first textarea, focus returns to
 *    triggerRef on close.
 *  - Three textareas (required-≥10 / optional-≤500 / optional-≤1000).
 *  - Submit calls window.open(url, "_blank", "noopener,noreferrer")
 *    then showToast then onClose.
 *  - In mode="post-crash": panel intro and first-field label switch,
 *    and a captured boundary error is rendered pinned + unremovable
 *    in the AttachmentList.
 *
 * @version v1.3.0-beta
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bug, X } from "lucide-react";
import { useToast } from "~/hooks/use-toast";
import {
  buildIssueBody,
  type FormInput,
  type Payload,
} from "./build-issue-body";
import { buildIssueUrl, deriveIssueTitle } from "./build-issue-url";
import { getRecentErrors, type CapturedError } from "~/lib/error-capture";
import { AttachmentList, type AttachmentItem } from "./AttachmentList";

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
export function buildPayload(repoFullName?: string): Payload {
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
  pinnedError,
  triggerRef,
}: BugReportPanelProps) {
  const { t } = useTranslation("bug-report");
  const { showToast } = useToast();
  const [whatHappened, setWhatHappened] = useState("");
  const [expected, setExpected] = useState("");
  const [steps, setSteps] = useState("");
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const firstInputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const payload = useMemo<Payload | null>(
    () => (open ? buildPayload(repoFullName) : null),
    [open, repoFullName],
  );

  // Escape closes.
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
    };
    const body = buildIssueBody(form, payload, removed, mode);
    const url = buildIssueUrl(body, deriveIssueTitle(trimmedWhat));
    window.open(url, "_blank", "noopener,noreferrer");
    showToast({ type: "info", message: t("submit_toast") });
    onClose();
  }

  // Build attachment items list. Pinned error (post-crash) goes first.
  const items: AttachmentItem[] = [];
  if (pinnedError) {
    items.push({
      key: "__pinned",
      label: t("attach_item_recent_error"),
      value: pinnedError.message,
      pinned: true,
    });
  }
  if (payload) {
    items.push({
      key: "url",
      label: t("attach_item_url"),
      value: payload.url,
    });
    if (payload.repoFullName) {
      items.push({
        key: "repository",
        label: t("attach_item_repository"),
        value: payload.repoFullName,
      });
    }
    items.push({
      key: "buildSha",
      label: t("attach_item_version"),
      value: `${payload.buildSha} (${payload.environment})`,
    });
    items.push({
      key: "browser",
      label: t("attach_item_browser"),
      value: payload.browser,
    });
    items.push({
      key: "viewport",
      label: t("attach_item_viewport"),
      value: payload.viewport,
    });
    items.push({
      key: "locale",
      label: t("attach_item_locale"),
      value: payload.locale,
    });
    items.push({
      key: "timestamp",
      label: t("attach_item_reported_at"),
      value: payload.timestamp,
    });
    for (const [i, e] of payload.errors.entries()) {
      items.push({
        key: `error-${i}`,
        label: t("attach_item_recent_error"),
        value: e.message,
      });
    }
  }

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
