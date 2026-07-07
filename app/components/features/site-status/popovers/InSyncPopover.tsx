/**
 * InSyncPopover — the affirmative "nothing to do" body of the Site Status pill.
 * Renders three rows sourced from the `in-sync` payload of `api.site-status`
 * (last published, commit sha + message, synced from repo) and a ghost
 * `View published site` button.
 *
 * Fail-open: the commit message is fetched lazily by the resource route and
 * may be null on any GitHub error — when absent, the commit row degrades to just
 * the short SHA (no `— {msg}` tail) and the timestamp rows still render.
 *
 * The payload is passed in as a prop (the pill fetches it on open and hands it
 * down) so this component stays a pure renderer — testable with a fixture, no
 * fetcher in the render path. Tokens are pixel-locked to the design system's
 * colour contract (ok swatch = chilca-pale / chilca-deep).
 *
 * @version v1.3.0-beta
 */

import { Globe, ArrowUpRight, Check, GitCommit, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

/** The `in-sync` payload shape served by api.site-status. */
export interface InSyncPayload {
  last_published_at: string | null;
  head_sha: string | null;
  last_synced_at: string | null;
  /** null when the lazy GitHub commit-message fetch failed open. */
  commitMessage: string | null;
}

export interface InSyncPopoverProps {
  payload: InSyncPayload;
  /** Published-site URL for the ghost "View published site" button. */
  pagesUrl: string | null;
  className?: string;
}

/**
 * Formats an ISO timestamp into a short human label; degrades to em-dash.
 * Locale is passed explicitly so the date matches the UI language rather than
 * the browser default. Timezone stays local — this shows a time of day, which
 * should read in the viewer's own zone. (Client-only: the pill fetches the
 * payload on open, so this never participates in SSR hydration.)
 */
function fmtTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Truncates a commit SHA to the 7-char short form (fail-open on empty). */
function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

function OkSwatch({ icon: Icon }: { icon: typeof Check }) {
  return (
    <span
      className="bg-chilca-pale text-chilca-deep flex items-center justify-center shrink-0"
      style={{ width: "22px", height: "22px", borderRadius: "5px" }}
      aria-hidden="true"
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

export function InSyncPopover({ payload, pagesUrl, className = "" }: InSyncPopoverProps) {
  const { t, i18n } = useTranslation("popover");

  // Commit row: include the message tail only when it survived the fail-open
  // fetch; otherwise render just `commit {sha}`.
  const commitBase = t("in_sync.commit", { sha: shortSha(payload.head_sha) });
  const commitLabel = payload.commitMessage
    ? `${commitBase} — ${payload.commitMessage}`
    : commitBase;

  return (
    <div className={className}>
      {/* Head */}
      <div
        className="border-b border-border"
        style={{ padding: "14px 18px 12px" }}
      >
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {t("in_sync.title")}
        </h3>
      </div>

      {/* Body: three rows */}
      <div className="flex flex-col" style={{ padding: "12px 18px 14px", gap: "10px" }}>
        <Row icon={Check} label={t("in_sync.published", { time: fmtTime(payload.last_published_at, i18n.language) })} />
        <Row icon={GitCommit} label={commitLabel} mono />
        <Row icon={RefreshCw} label={t("in_sync.synced", { time: fmtTime(payload.last_synced_at, i18n.language) })} />
      </div>

      {/* Footer: ghost View published site */}
      <div
        className="border-t border-border bg-cream flex"
        style={{ padding: "11px 14px 12px" }}
      >
        <a
          href={pagesUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="font-heading font-semibold inline-flex items-center gap-1.5 bg-surface border border-border text-charcoal hover:bg-cream transition-colors"
          style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "0.375rem" }}
        >
          <Globe className="w-3.5 h-3.5" aria-hidden="true" />
          {t("in_sync.view_site")}
          <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

function Row({ icon, label, mono = false }: { icon: typeof Check; label: string; mono?: boolean }) {
  return (
    <div className="flex items-center" style={{ gap: "9px" }}>
      <OkSwatch icon={icon} />
      <span
        className={`text-charcoal ${mono ? "font-mono" : "font-body"}`}
        style={{ fontSize: mono ? "10.5px" : "12.5px", fontWeight: mono ? 400 : 600 }}
      >
        {label}
      </span>
    </div>
  );
}
