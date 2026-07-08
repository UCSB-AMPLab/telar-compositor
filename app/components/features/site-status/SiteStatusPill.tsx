/**
 * SiteStatusPill — the global, user-visible Site Status pill. It lives
 * right-aligned in the existing Header on every authenticated route and shows
 * exactly ONE of six states (repo-unavailable > publishing > out-of-sync >
 * unpublished > upgrade > in-sync) via the `useSiteStatus()` hook, in that
 * precedence order.
 *
 * Each state renders its LOCKED bg/ink/dot token set; only the `publishing` dot
 * carries the `site-status-pulse` ring keyframe — Tailwind `animate-pulse` is
 * deliberately NOT used (the design pulses the ring shadow, not opacity). Two
 * states carry a trailing action divider: `unpublished` (`Publish →`) and
 * `out-of-sync` (`Review →`); the other four render caption-only.
 *
 * Geometry is pixel-locked to the source design and applied inline because the
 * values sit off the Tailwind 4px grid: pill padding `4px 11px 4px 9px`, gap
 * `7px`, `7px×7px` dot, caption 12px/600, action 12px/700, action divider 4px
 * margin / 8px padding. These are intentionally NOT snapped to a grid.
 *
 * Clicking the pill toggles the shared `StatusPopoverShell` hosting the popover
 * matching the active state. The popover BODY is fetched lazily from
 * `api.site-status` on open (only for the three payload-backed states —
 * unpublished / out-of-sync / in-sync) to keep the global pill cheap. The
 * `publishing` and `upgrade` popovers need no api.site-status payload:
 * publishing drives the existing poll-build loop from the off-route SHA lifted
 * into awareness; upgrade renders from the `_app` loader's version fields.
 *
 * The transient `Saving…` overlay is rendered adjacent to the caption WITHOUT
 * recolouring the base state — it is an overlay, not a seventh state, and never
 * competes in the state precedence.
 *
 * Light mode only; lucide-react icons only; `~/` imports; accepts `className`.
 *
 * @version v1.3.7-beta
 */

import { useState } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import {
  useSiteStatus,
  type SiteStatusState,
} from "~/components/features/site-status/useSiteStatus";
import { StatusPopoverShell } from "~/components/features/site-status/StatusPopoverShell";
import { InSyncPopover, type InSyncPayload } from "~/components/features/site-status/popovers/InSyncPopover";
import { UnpublishedPopover } from "~/components/features/site-status/popovers/UnpublishedPopover";
import { OutOfSyncPopover } from "~/components/features/site-status/popovers/OutOfSyncPopover";
import { PublishingPopover } from "~/components/features/site-status/popovers/PublishingPopover";
import { UpgradePopover } from "~/components/features/site-status/popovers/UpgradePopover";
import { RepoUnavailablePopover } from "~/components/features/site-status/popovers/RepoUnavailablePopover";
import type { ChangeSummary } from "~/lib/publish.server";
import type { FullSyncDiff } from "~/lib/sync.server";

/** Per-state LOCKED token sets. */
interface StateConfig {
  /** Pill background token. */
  bg: string;
  /** Pill ink token. */
  ink: string;
  /** Dot background token. */
  dot: string;
  /** i18n key for the caption (interpolated for unpublished/upgrade). */
  captionKey: string;
  /** i18n key for the trailing action label, or null (caption-only state). */
  actionKey: string | null;
  /**
   * Which api.site-status payload (if any) the matching popover needs on open.
   * publishing/upgrade are null — they render without a payload fetch.
   */
  payload: "in-sync" | "unpublished" | "out-of-sync" | null;
}

const STATE_CONFIG: Record<SiteStatusState, StateConfig> = {
  "in-sync": {
    bg: "bg-chilca-pale",
    ink: "text-chilca-deep",
    dot: "bg-chilca",
    captionKey: "status.in_sync",
    actionKey: null,
    payload: "in-sync",
  },
  unpublished: {
    bg: "bg-cream-dark",
    ink: "text-terracotta",
    dot: "bg-terracotta",
    captionKey: "status.unpublished_other",
    actionKey: "status.publish_cta",
    payload: "unpublished",
  },
  "out-of-sync": {
    bg: "bg-qolle-pale",
    ink: "text-qolle-deep",
    dot: "bg-qolle",
    captionKey: "status.out_of_sync",
    actionKey: "status.review_cta",
    payload: "out-of-sync",
  },
  publishing: {
    bg: "bg-anil-pale",
    ink: "text-anil-ink",
    dot: "bg-anil-deep",
    captionKey: "status.publishing",
    actionKey: null,
    payload: null,
  },
  upgrade: {
    bg: "bg-terracotta-pale",
    ink: "text-terracotta",
    dot: "bg-terracotta",
    captionKey: "status.upgrade",
    actionKey: null,
    payload: null,
  },
  "repo-unavailable": {
    bg: "bg-terracotta-pale",
    ink: "text-terracotta",
    dot: "bg-terracotta",
    captionKey: "status.repo_unavailable",
    actionKey: null,
    payload: null,
  },
};

/** Subset of the `_app` loader the pill reads for popover props. */
interface AppLoaderData {
  pagesUrl?: string | null;
  latestTelarTag?: string | null;
  repoFullName?: string | null;
}

export interface SiteStatusPillProps {
  className?: string;
}

export function SiteStatusPill({ className = "" }: SiteStatusPillProps) {
  const { t } = useTranslation("common");
  const { state, saving, count, latestTag, userRole, needsUpgrade } = useSiteStatus();
  const { publishSha, publishCommitUrl } = useCollaborationContext();
  const app = (useRouteLoaderData("routes/_app") as AppLoaderData | null) ?? null;

  const [open, setOpen] = useState(false);

  // Lazy payload fetcher: only fires on open, for the three payload-backed
  // states — keeps the global pill cheap.
  const payloadFetcher = useFetcher();

  const cfg = STATE_CONFIG[state];

  // Caption: unpublished is pluralised by count; upgrade interpolates the tag.
  const caption =
    state === "unpublished"
      ? count === 1
        ? t("status.unpublished_one", { n: count })
        : t("status.unpublished_other", { n: count })
      : state === "upgrade"
        ? t("status.upgrade", { version: latestTag ?? "" })
        : t(cfg.captionKey);

  const actionLabel = cfg.actionKey ? t(cfg.actionKey) : null;

  function handleToggle() {
    const next = !open;
    setOpen(next);
    // Fetch the popover body only when opening a payload-backed state.
    if (next && cfg.payload) {
      payloadFetcher.load(`/api/site-status?payload=${cfg.payload}`);
    }
  }

  const isPulsing = state === "publishing";

  return (
    <div className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={handleToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center font-heading ${cfg.bg} ${cfg.ink} transition-colors`}
        style={{
          padding: "4px 11px 4px 9px",
          gap: "7px",
          borderRadius: "9999px",
          lineHeight: 1,
        }}
      >
        {/* Per-state dot; only publishing pulses (ring shadow, not opacity). */}
        <span
          className={`inline-block shrink-0 rounded-full ${cfg.dot} ${isPulsing ? "site-status-pulse" : ""}`}
          style={{ width: "7px", height: "7px" }}
          aria-hidden="true"
        />

        {/* Caption — 12px / 600. */}
        <span style={{ fontSize: "12px", fontWeight: 600 }}>{caption}</span>

        {/* Transient Saving… overlay — adjacent, no recolour. */}
        {saving && (
          <span
            role="status"
            aria-live="polite"
            className="font-body opacity-70"
            style={{ fontSize: "12px", fontWeight: 400, marginLeft: "4px" }}
          >
            {t("status.saving")}
          </span>
        )}

        {/* Per-state action divider + label (only the two actionable states).
            Hidden on phones to keep the header from crowding the avatar cluster;
            the same action is still reachable by tapping the pill (it opens the
            popover, which carries the action). */}
        {actionLabel && (
          <span
            className="hidden sm:inline-flex items-center border-l border-current/30"
            style={{ marginLeft: "4px", paddingLeft: "8px", fontSize: "12px", fontWeight: 700 }}
          >
            {actionLabel} →
          </span>
        )}
      </button>

      <StatusPopoverShell open={open} onClose={() => setOpen(false)}>
        {renderPopover(state, payloadFetcher.data, {
          pagesUrl: app?.pagesUrl ?? null,
          latestTag: latestTag ?? app?.latestTelarTag ?? null,
          userRole,
          needsUpgrade,
          publishSha: publishSha ?? null,
          publishCommitUrl: publishCommitUrl ?? null,
          repoFullName: app?.repoFullName ?? null,
        })}
      </StatusPopoverShell>
    </div>
  );
}

/** Props the pill threads through to the per-state popover. */
interface PopoverDeps {
  pagesUrl: string | null;
  latestTag: string | null;
  userRole: "convenor" | "collaborator" | null;
  needsUpgrade: boolean;
  publishSha: string | null;
  publishCommitUrl: string | null;
  repoFullName: string | null;
}

/**
 * Renders the popover body matching the active state. For the three
 * payload-backed states the lazily-fetched data arrives via `data`; while it is
 * still loading (data === undefined) the popovers render their graceful empty /
 * fail-open shapes.
 */
function renderPopover(
  state: SiteStatusState,
  data: unknown,
  deps: PopoverDeps,
) {
  switch (state) {
    case "in-sync": {
      const payload =
        (data as InSyncPayload | undefined) ?? {
          last_published_at: null,
          head_sha: null,
          last_synced_at: null,
          commitMessage: null,
        };
      return <InSyncPopover payload={payload} pagesUrl={deps.pagesUrl} />;
    }
    case "unpublished": {
      const summary = data as ChangeSummary | undefined;
      if (!summary) return <UnpublishedPopover summary={EMPTY_SUMMARY} />;
      return <UnpublishedPopover summary={summary} />;
    }
    case "out-of-sync": {
      const diff = data as FullSyncDiff | undefined;
      if (!diff) return <OutOfSyncPopover diff={EMPTY_DIFF} />;
      return <OutOfSyncPopover diff={diff} />;
    }
    case "publishing":
      return (
        <PublishingPopover
          phases={null}
          sha={deps.publishSha}
          commitUrl={deps.publishCommitUrl}
        />
      );
    case "upgrade":
      return (
        <UpgradePopover
          latestVersion={deps.latestTag ?? "—"}
          currentVersion="—"
          whatsNew={[]}
          userRole={deps.userRole}
        />
      );
    case "repo-unavailable":
      return (
        <RepoUnavailablePopover
          repoFullName={deps.repoFullName}
          userRole={deps.userRole}
        />
      );
  }
}

/** Empty ChangeSummary while the unpublished manifest is still loading. */
const EMPTY_SUMMARY: ChangeSummary = {
  isUpToDate: true,
  backCompatBootstrap: false,
  stories: { new: [], modified: [], deleted: [] },
  objects: { new: [], modified: [], deleted: [] },
  pages: { new: [], modified: [], deleted: [] },
  glossary: { new: [], modified: [], deleted: [] },
  settings: { changed: [] },
  landing: { changed: false },
  navigation: { changed: false },
  fileChanges: { addedStoryFiles: [], removedStoryFiles: [] },
};

/** Empty FullSyncDiff while the out-of-sync diff is still loading. */
const EMPTY_DIFF: FullSyncDiff = {
  objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
  stories: { newStories: [], changedStories: [], missingStories: [] },
  config: { changedFields: [], versionChange: null },
  glossary: { added: [], removed: [], changed: [] },
  hasConflicts: false,
  classification: "two-way",
  suppressedEditorOnly: 0,
};
