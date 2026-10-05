/**
 * SiteStatusPill — the global, user-visible Site Status pill. It lives
 * right-aligned in the existing Header on every authenticated route and shows
 * exactly ONE of eight states (persistence-halted > repo-unavailable >
 * publishing > out-of-sync > repo-invitation > unpublished > upgrade > in-sync) via the
 * `useSiteStatus()` hook, in that precedence order.
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
 * matching the active state. The popover BODY is read from `api.site-status`
 * while the popover is open (only for the three payload-backed states —
 * unpublished / out-of-sync / in-sync) to keep the global pill cheap, and again
 * after every submission while it stays open. It is a background read
 * (`useBackgroundRead`): a failed read keeps the last body, and the kept body
 * is only ever the current payload's, so one state's body is never handed to
 * another state's popover. The
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
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useBackgroundRead } from "~/hooks/use-background-read";
import { usePageSite } from "~/lib/page-site";
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
import { RepoInvitationPopover } from "~/components/features/site-status/popovers/RepoInvitationPopover";
import { RepoUnavailablePopover } from "~/components/features/site-status/popovers/RepoUnavailablePopover";
import { PersistenceHaltedPopover } from "~/components/features/site-status/popovers/PersistenceHaltedPopover";
import type { OwnRepoAccess } from "~/lib/repo-access";
import type { PersistenceHaltResult } from "~/hooks/use-persistence-halt";
import { isPublishingRole } from "~/lib/publishing-roles";
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
  "repo-invitation": {
    bg: "bg-terracotta-pale",
    ink: "text-terracotta",
    dot: "bg-terracotta",
    captionKey: "status.repo_invitation",
    actionKey: null,
    payload: null,
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
    actionKey: "status.upgrade_cta",
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
  "persistence-halted": {
    bg: "bg-terracotta-pale",
    ink: "text-terracotta",
    dot: "bg-terracotta",
    captionKey: "status.halted",
    actionKey: "status.halted_action",
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

/**
 * The trailing action label, or null for a caption-only state and for the
 * halted state's restore, which is the convenor's alone, and the upgrade's
 * run, which a publishing role alone can act on — anyone else gets the
 * caption with no action.
 */
function actionLabelFor(
  cfg: StateConfig,
  state: SiteStatusState,
  userRole: "convenor" | "collaborator" | "instructor" | null,
  t: TFunction<"common">,
): string | null {
  if (cfg.actionKey === null) return null;
  if (state === "persistence-halted" && userRole !== "convenor") return null;
  if (state === "upgrade" && !isPublishingRole(userRole)) return null;
  return t(cfg.actionKey);
}

export function SiteStatusPill({ className = "" }: SiteStatusPillProps) {
  const { t } = useTranslation("common");
  const { state, saving, count, countKnown, latestTag, userRole, needsUpgrade, ownRepoAccess, persistence } =
    useSiteStatus();
  const { publishSha, publishCommitUrl } = useCollaborationContext();
  const app = (useRouteLoaderData("routes/_app") as AppLoaderData | null) ?? null;

  const [open, setOpen] = useState(false);

  const cfg = STATE_CONFIG[state];

  const payloadData = useBackgroundRead<unknown>({
    url: cfg.payload ? `/api/site-status?payload=${cfg.payload}` : null,
    enabled: open,
    afterActions: true,
    scope: usePageSite().live,
  });

  // Caption: unpublished is pluralised by count; upgrade interpolates the tag.
  const caption =
    state === "unpublished"
      ? !countKnown
        ? t("status.unpublished")
        : count === 1
          ? t("status.unpublished_one", { n: count })
          : t("status.unpublished_other", { n: count })
      : state === "upgrade"
        ? t("status.upgrade", { version: latestTag ?? "" })
        : t(cfg.captionKey);

  const actionLabel = actionLabelFor(cfg, state, userRole, t);

  const haltedMounted = haltedPopoverMounted(persistence);

  // Shared close path for every dismissal — the pill's own click-to-close,
  // the shell's outside-click overlay, and its Escape listener all route
  // here so a displayed outcome is cleared regardless of which one fired.
  function closePopover() {
    setOpen(false);
    // A result the reader has seen and closed gives the other six bodies their
    // turn; the halt itself, if it still stands, keeps the popover.
    if (persistence.outcome !== null) persistence.dismissOutcome();
  }

  function handleToggle() {
    if (open) {
      closePopover();
      return;
    }
    setOpen(true);
    // The automatic reads stop at the first halt, so what the halted popover
    // shows is only as fresh as its opening makes it.
    if (haltedMounted) persistence.checkAgain();
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

        {/* Caption — 12px / 600. The captions are long (in Spanish more than
            in English) and on a phone they crowd the project switcher, so in
            every state they shrink to the dot and stay readable to assistive
            technology; the pill's colour and its popover carry the rest. */}
        <span
          className="max-sm:sr-only"
          style={{ fontSize: "12px", fontWeight: 600 }}
        >
          {caption}
        </span>

        {/* Transient Saving… overlay — adjacent, no recolour. */}
        {saving && (
          <span
            role="status"
            aria-live="polite"
            className="font-body opacity-70 max-sm:sr-only"
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

      <StatusPopoverShell open={open} onClose={closePopover}>
        {renderPopover(state, payloadData, {
          pagesUrl: app?.pagesUrl ?? null,
          latestTag: latestTag ?? app?.latestTelarTag ?? null,
          userRole,
          needsUpgrade,
          publishSha: publishSha ?? null,
          publishCommitUrl: publishCommitUrl ?? null,
          repoFullName: app?.repoFullName ?? null,
          ownRepoAccess,
          persistence,
        })}
      </StatusPopoverShell>
    </div>
  );
}

/** Props the pill threads through to the per-state popover. */
interface PopoverDeps {
  pagesUrl: string | null;
  latestTag: string | null;
  userRole: "convenor" | "collaborator" | "instructor" | null;
  needsUpgrade: boolean;
  publishSha: string | null;
  publishCommitUrl: string | null;
  repoFullName: string | null;
  ownRepoAccess: OwnRepoAccess | null;
  persistence: PersistenceHaltResult;
}

/**
 * Whether the halted body owns the popover: a remembered halt, a restore whose
 * answer has not arrived, or the answer to one.
 *
 * The pending action is the case a halt-and-outcome test misses. An admission
 * can land between the click and the response, clearing the halt while there is
 * no outcome yet, and without it the convenor's action would vanish mid-flight.
 */
function haltedPopoverMounted(persistence: PersistenceHaltResult): boolean {
  return (
    persistence.lastKnownHalt !== null ||
    persistence.outcome !== null ||
    persistence.submitting
  );
}

/**
 * The halted popover, mounted by the state above rather than by the switch
 * below: the pill's state can be re-derived away from `persistence-halted` by
 * an admission that arrives while the convenor is reading what the restore did,
 * and the body has to survive that.
 */
function haltedPopoverIfMounted(deps: PopoverDeps) {
  const { persistence } = deps;
  if (!haltedPopoverMounted(persistence)) return null;
  return (
    <PersistenceHaltedPopover
      halt={persistence.lastKnownHalt}
      stateUnreadable={persistence.stateUnreadable}
      confirmedGeneration={persistence.confirmedGeneration}
      lastReadHalted={persistence.lastReadHalted}
      haltedAgain={persistence.haltedAgain}
      outcome={persistence.outcome}
      submitting={persistence.submitting}
      userRole={deps.userRole}
      onCheckAgain={persistence.checkAgain}
      onRestore={persistence.restore}
    />
  );
}

/** The in-sync payload once it has arrived, or the empty shape while it loads. */
function inSyncPayloadFor(data: unknown): InSyncPayload {
  return (data as InSyncPayload | undefined) ?? EMPTY_IN_SYNC;
}

/** The unpublished summary once it has arrived, or the empty shape while it loads. */
function unpublishedSummaryFor(data: unknown): ChangeSummary {
  return (data as ChangeSummary | undefined) ?? EMPTY_SUMMARY;
}

/** The out-of-sync diff once it has arrived, or the empty shape while it loads. */
function outOfSyncDiffFor(data: unknown): FullSyncDiff {
  return (data as FullSyncDiff | undefined) ?? EMPTY_DIFF;
}

/** The upgrade popover's headline version, or the placeholder while unknown. */
function upgradeVersionFor(latestTag: string | null): string {
  return latestTag ?? "—";
}

/** The popover body for one state, once the halted case has been ruled out. */
function popoverForState(state: SiteStatusState, data: unknown, deps: PopoverDeps) {
  switch (state) {
    case "in-sync":
      return <InSyncPopover payload={inSyncPayloadFor(data)} pagesUrl={deps.pagesUrl} />;
    case "unpublished":
      return <UnpublishedPopover summary={unpublishedSummaryFor(data)} />;
    case "out-of-sync":
      return <OutOfSyncPopover diff={outOfSyncDiffFor(data)} />;
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
          latestVersion={upgradeVersionFor(deps.latestTag)}
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
    case "repo-invitation":
      return deps.ownRepoAccess ? <RepoInvitationPopover access={deps.ownRepoAccess} /> : null;
    case "persistence-halted":
      // Reached only when the state was derived from a halt the mount check
      // in renderPopover has since cleared, which the shell renders as nothing.
      return null;
  }
}

/**
 * Renders the popover body matching the active state. For the three
 * payload-backed states the payload read arrives via `data`; until an answer for
 * the current payload has arrived (data === undefined) the popovers render
 * their graceful empty / fail-open shapes.
 */
function renderPopover(
  state: SiteStatusState,
  data: unknown,
  deps: PopoverDeps,
) {
  return haltedPopoverIfMounted(deps) ?? popoverForState(state, data, deps);
}

/** Empty InSyncPayload while the last-published/synced data is still loading. */
const EMPTY_IN_SYNC: InSyncPayload = {
  last_published_at: null,
  head_sha: null,
  last_synced_at: null,
  commitMessage: null,
  blobBytes: null,
};

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
  objectOrder: { changed: false },
  fileChanges: { addedStoryFiles: [], removedStoryFiles: [] },
};

/** Empty FullSyncDiff while the out-of-sync diff is still loading. */
const EMPTY_DIFF: FullSyncDiff = {
  objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null },
  stories: { newStories: [], changedStories: [], missingStories: [] },
  config: { changedFields: [], versionChange: null },
  glossary: { added: [], removed: [], changed: [] },
  hasConflicts: false,
  classification: "two-way",
  suppressedEditorOnly: 0,
  unreadableFiles: [],
};
