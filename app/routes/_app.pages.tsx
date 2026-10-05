/**
 * This file is the Pages route — the static page editor for the
 * active project. Where the user adds and orders the custom pages
 * that appear in their site's top navigation alongside Home,
 * Objects, Glossary, and Share.
 *
 * The tab bar is a live preview of the site's navigation menu: site
 * title on the left, right-aligned nav items (Home, Objects,
 * Glossary, user pages, Share). User pages are draggable; all nav
 * items are rearrangeable. A `+` button on the left creates new
 * pages.
 *
 * Slug generation is deferred — pages start with an empty
 * (placeholder) slug and the slug auto-generates from the title
 * once the user edits it. That lets the user create a new page
 * without immediately committing to a URL.
 *
 * @version v1.5.0-beta
 */

import { asc, eq, and } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher, useOutletContext } from "react-router";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as Y from "yjs";
import { decrypt } from "~/lib/crypto.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { isTransientGitHubFailure } from "~/lib/github.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { scanRepoPages } from "~/lib/import.server";
import { pagesImportCommit, recordPagesImport, reducedPagesScan } from "~/lib/page-files-record.server";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { capturePagesOnLoad } from "~/lib/page-capture.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import type { IngestPageInsert } from "../../workers/collaboration";
import { partitionOnIdentityDomain } from "../../workers/can-delete";
import { DndContext, closestCenter } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useSortableSensors } from "~/hooks/use-sortable-sensors";
import { Upload } from "lucide-react";
import type { Route } from "./+types/_app.pages";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { project_pages, project_members, users } from "~/db/schema";
import { resolveActiveProjectFromRequest, resolvePageProject, siteChangedAnswer } from "~/lib/active-project.server";
import { requireProjectMember } from "~/lib/membership.server";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { useSiteFetcher } from "~/lib/page-site";
import { normaliseSlug, makeUniqueSlug, isTemporaryPageSlug } from "~/lib/slug";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { SlugField } from "~/components/ui/SlugField";
import { SortablePageTab } from "~/components/features/pages/SortablePageTab";
import { PagesRepoImportEmptyState } from "~/components/features/pages/PagesEmptyState";
import { DocsLink } from "~/components/ui/DocsLink";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { useYjsArraySync } from "~/hooks/use-yjs-array-sync";
import { compareByOrderKey, readOrderKey } from "~/lib/field-order";
import { useToast } from "~/hooks/use-toast";
import { keyFor } from "~/lib/item-key";
import { useRemoteDeleteToast } from "~/hooks/use-remote-delete-toast";
import { menuPreviewEntries, mergeNavItemsWithPages } from "~/lib/nav-merge";
import { removeNavEntries } from "~/lib/pages-screen";
import { buildSidebarRows } from "~/lib/pages-sidebar-rows";
import { navReconcileSignature, reconcileNavPageSlugs } from "~/lib/nav-reconcile";
import { findYMapByIdOrTempId, getYText, reorderNavArray, sanitizeNavArray } from "~/lib/yjs-helpers";
import { HomepageEditor } from "~/components/features/pages/HomepageEditor";
import { PagesSidebar, HOME_ROW_KEY, type PagesSidebarRow } from "~/components/features/pages/PagesSidebar";
import { loadHomepageEditorData } from "~/lib/homepage-editor-data.server";
import { answerReadsWhenUnreachable, isUnreachableAnswer } from "~/lib/unreachable-write";
import { useRetryWhileUnreachable } from "~/lib/use-retry-unreachable";

export const handle = { i18n: ["common", "pages", "editor", "structural"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    throw redirect("/dashboard");
  }
  const { project: activeProject, userRole } = resolved;

  const pages = await capturePagesOnLoad(
    env,
    user,
    activeProject,
    userRole,
    await db
      .select()
      .from(project_pages)
      .where(eq(project_pages.project_id, activeProject.id))
      .orderBy(asc(project_pages.order)),
  );

  const memberRows = await db
    .select({
      userId: project_members.user_id,
      name: users.github_name,
      login: users.github_login,
    })
    .from(project_members)
    .innerJoin(users, eq(project_members.user_id, users.id))
    .where(eq(project_members.project_id, activeProject.id));

  const members = memberRows.map((m) => ({
    userId: m.userId,
    name: m.name || m.login,
  }));

  // The pinned Home sidebar row mounts the shared HomepageEditor in the
  // right pane. Source its data here (same shape as the _app.homepage loader)
  // so the landing editor is "reused AS-IS in-place" without a separate route.
  const landingData = await loadHomepageEditorData(db, activeProject);

  return {
    project: activeProject,
    pages,
    members,
    currentUserId: user.id,
    userRole,
    landingData,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Saves a page's body on the page row's own site, which is the one the page
 * showed it on, for a member of that site, whichever site the session names.
 */
async function autosavePageBody(db: ReturnType<typeof getDb>, userId: number, formData: FormData) {
  const pageId = Number(formData.get("projectId"));
  const value = formData.get("value") as string;
  if (!pageId || value === null) throw new Response("Bad request", { status: 400 });
  const [page] = await db
    .select({ project_id: project_pages.project_id })
    .from(project_pages)
    .where(eq(project_pages.id, pageId))
    .limit(1);
  if (!page) throw new Response("Not found", { status: 404 });
  await requireProjectMember(db, page.project_id, userId);
  await db
    .update(project_pages)
    .set({ body: value, updated_at: new Date().toISOString() })
    .where(eq(project_pages.id, pageId));
  return { ok: true, intent: "autosave-page-body" };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Handled before the page-site check: it acts on the page row's own site.
  if (intent === "autosave-page-body") return autosavePageBody(db, user.id, formData);

  // Every other intent acts on the session's site, and only when the page
  // that posted it showed that site.
  const resolved = await resolvePageProject(request, env, user.id, formData);
  if (resolved.kind === "site_changed") {
    return siteChangedAnswer(intent, resolved.currentSiteName);
  }
  if (resolved.kind === "no_project") {
    throw new Response("Not found", { status: 404 });
  }
  const { project: activeProject, userRole } = resolved;
  const activeProjectId = activeProject.id;

  switch (intent) {

    // ---- Surface existing repo pages on the empty-state ----
    case "scan-repo-pages": {
      // Probe the connected repo for telar-content/texts/pages/*.md and return
      // the parsed page records. Called from the Pages tab when displayPages
      // is empty so the UI can offer per-row + "Import all" actions instead
      // of the plain empty-state.
      //
      // Fail open: this scan fires automatically on mount (the empty-state
      // effect in the component). If the repo tree can't be fetched —
      // getRepoTree throws on a non-2xx, e.g. an empty repo with no commits
      // 404s on GET /git/trees/HEAD — an uncaught throw here is sanitised by
      // React Router into a root-level "Unexpected Server Error" that
      // white-screens the whole Pages tab. A best-effort scan must degrade to
      // the plain empty state instead, so the user can still create pages by
      // hand. Return an empty list on any failure.
      try {
        // decrypt is inside the guard too — a corrupted token would otherwise
        // throw past the fail-open design straight into the 500 this comment
        // warns about. resolveProjectToken hands the installation token only
        // to a publishing role, falling back to the convenor's own on a mint
        // failure — this intent carries no role gate of its own, so a
        // non-member reads no more than their own GitHub account already can.
        const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const token = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          userToken,
          userRole,
        );
        // A page whose bytes are not valid UTF-8 is named here, before the
        // import stores it.
        const warnings: SheetWarning[] = [];
        // The commit the import reads, so the list is what it will bring in.
        const scanCommit = await pagesImportCommit({ token, owner, repo }, activeProject.head_sha);
        const scanned = await scanRepoPages(token, owner, repo, scanCommit, { warnings, repair: "import_then_publish" });
        const { pages } = await reducedPagesScan(env.DB, activeProjectId, scanned);
        return { ok: true, intent: "scan-repo-pages", pages, warnings };
      } catch (err) {
        console.error("scan-repo-pages failed; degrading to empty state:", err);
        return scanFailureAnswer(err);
      }
    }

    case "import-pages": {
      // Bring one or more repo pages into the active project THROUGH the
      // collaboration DO's /ingest-sync endpoint. Slugs may be filtered via
      // repeated `slugs` form fields; omitting them imports every page
      // returned by scanRepoPages. A slug the project already holds is skipped
      // (no overwrite) and named in `already_present` so the UI can surface it.
      //
      // This action writes NO project_pages row itself, and must not be given
      // one back. `project_pages(project_id, slug)` is UNIQUE, and the
      // snapshot's slug re-key seeds its minted key from a read taken many
      // statements before the batch that carries the resulting UPDATE. A row
      // inserted here inside that window takes the minted slug, the UPDATE
      // aborts, and D1 discards the whole batch — while the re-keyed document
      // survives in the blob write that precedes it, so every retry re-issues
      // the same colliding UPDATE and the project's snapshot never recovers.
      // Routing through the DO removes the second writer: the page lands in the
      // Y.Doc inside blockConcurrencyWhile, the snapshot in that same gate
      // writes the row, and the mint's taken-key set already covers it.
      //
      // The DO broadcasts the new document state to connected editors, so the
      // page appears in the tab without a client-side mirror step.
      const requestedSlugs = formData.getAll("slugs").map((s) => String(s));
      // Same fail-open guard as scan-repo-pages: getRepoTree throws on a
      // non-2xx (e.g. an empty repo's tree 404s), and decrypt throws on a
      // corrupted token. This action is user-initiated and only reachable
      // after a successful scan, so a throw here is a rare transient — but an
      // uncaught one still white-screens the tab. Return a structured failure
      // so the client can clear its spinners and toast.
      let allPages: Awaited<ReturnType<typeof scanRepoPages>>;
      // The files the reduction to one file per page removed, recorded with no
      // page, and the page each served one is served at.
      let removedFiles: string[];
      let servedAt: Record<string, string>;
      // The commit scanned: the recorded head when there is one, so the pages
      // brought in are those of the commit the Compositor has read (R10).
      let scanCommit: string;
      try {
        const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const token = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          userToken,
          userRole,
        );
        scanCommit = await pagesImportCommit({ token, owner, repo }, activeProject.head_sha);
        ({ pages: allPages, removed: removedFiles, servedAt } = await reducedPagesScan(
          env.DB, activeProjectId, await scanRepoPages(token, owner, repo, scanCommit),
        ));
      } catch (err) {
        console.error("import-pages scan failed:", err);
        return {
          ok: false,
          intent: "import-pages",
          imported: 0,
          pages: [],
          already_present: [],
        };
      }
      const candidatePages = requestedSlugs.length > 0
        ? allPages.filter((p) => requestedSlugs.includes(p.slug))
        : allPages;

      // Nothing to import: answer without waking the DO. An empty ingest would
      // still cost a snapshot on a project that has no reason to take one.
      if (candidatePages.length === 0) {
        return {
          ok: true,
          intent: "import-pages",
          imported: 0,
          pages: [],
          already_present: [],
        };
      }

      // `order` is deliberately not sent: a page's place is its order_key, which
      // the DO mints at the end of the pages array, and the "order" column is
      // the dense rank the snapshot derives from that. Sending the repo's
      // integer would set a column the next snapshot overwrites.
      //
      // A slug is an identity value: the snapshot's dedupe and re-key read it
      // by rendering whatever stands at the key, so a value that is not a
      // non-empty string either claims a colleague's page or lands unkeyed.
      // The repo scan should never produce one, which is why this is defence
      // in depth rather than the fix — the DO refuses it too, and that
      // boundary covers every producer.
      const vetted = partitionOnIdentityDomain(candidatePages, "pages", (p) => p.slug);
      if (vetted.refused.length > 0) {
        // By position, never by value: rendering an untrusted value to name it
        // is the operation that makes one into a colleague's key.
        console.error(
          `import-pages: refused ${vetted.refused.length} scanned page(s) for project ` +
            `${activeProjectId} at position(s) ${vetted.refused.join(", ")} — slug out of domain`,
        );
      }

      // Nothing legal to import, so the DO is not woken — the same reason the
      // empty-candidate answer above skips it. The answer is still a failure:
      // the author asked for pages and got none.
      if (vetted.accepted.length === 0) {
        return {
          ok: false,
          intent: "import-pages",
          imported: 0,
          pages: [],
          already_present: [],
        };
      }

      const inserts: IngestPageInsert[] = vetted.accepted.map((p) => ({
        slug: p.slug,
        title: p.title,
        body: p.body,
        frontmatter: p.frontmatter,
        created_by: user.id,
      }));

      const headers = await makeInternalMarkerHeaders(
        activeProjectId,
        env.SESSION_SECRET,
        "ingest-sync",
      );
      const stub = env.COLLABORATION.get(
        env.COLLABORATION.idFromName(String(activeProjectId)),
      );

      // The fetch (and the JSON parse below) sit inside this guard because a
      // DO rejection is not the same event as a non-2xx response: an
      // exception escaping a blockConcurrencyWhile callback gets the
      // instance terminated by Cloudflare, and the in-flight fetch rejects
      // rather than answering. Left unguarded, that rejection would escape
      // this action past the structured failure below, and React Router's
      // root error boundary would replace the whole Pages tab, stranding the
      // client's import spinners and disabled buttons. The ingest is
      // idempotent by slug either way, so a rejection and a bad response are
      // both told to the user as the same retryable failure — the client
      // does not currently act differently on the reason, only on ok.
      let ingestBody: {
        insertedPages?: Record<string, number>;
        applied?: { pageInsert?: number };
        skipped?: { pageInsert?: string[] };
        failed?: { pageInsert?: string[] };
        refused?: { pageInsert?: number[] };
      };
      try {
        const ingestRes = await stub.fetch(
          new Request("https://internal/ingest-sync", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ pages: { insert: inserts } }),
          }),
        );
        if (!ingestRes.ok) {
          // The ingest is idempotent by slug, so the honest answer is a failure
          // the user can retry — not a success that wrote nothing.
          console.error(
            `import-pages ingest failed for project ${activeProjectId}: DO returned ${ingestRes.status}`,
          );
          return {
            ok: false,
            intent: "import-pages",
            imported: 0,
            pages: [],
            already_present: [],
          };
        }

        // Presence is the DO's answer, not a pre-read of D1: the document is what
        // the snapshot writes from, and asking D1 here would be the read-then-write
        // gap this route was moved off.
        ingestBody = (await ingestRes.json()) as {
          insertedPages?: Record<string, number>;
          applied?: { pageInsert?: number };
          skipped?: { pageInsert?: string[] };
          failed?: { pageInsert?: string[] };
          refused?: { pageInsert?: number[] };
        };
      } catch (err) {
        console.error(
          `import-pages ingest unreachable for project ${activeProjectId}:`,
          err,
        );
        return {
          ok: false,
          intent: "import-pages",
          imported: 0,
          pages: [],
          already_present: [],
        };
      }
      const alreadyPresent = ingestBody.skipped?.pageInsert ?? [];
      // A refused INSERT is its own outcome: the endpoint reports it separately
      // because a row D1 does not hold is neither imported nor already present,
      // and listing it here would tell the author their page arrived.
      const notWritten = new Set([
        ...alreadyPresent,
        ...(ingestBody.failed?.pageInsert ?? []),
      ]);
      // Slugs the DO's own boundary refused, by position in the arm sent from
      // here. Each had already passed the identical rule above, so a non-empty
      // list means the two disagree and is worth its own log.
      const outOfDomainAt = ingestBody.refused?.pageInsert ?? [];
      if (outOfDomainAt.length > 0) {
        console.error(
          `import-pages: the DO refused ${outOfDomainAt.length} page(s) for project ` +
            `${activeProjectId} at position(s) ${outOfDomainAt.join(", ")} — slug out of ` +
            `domain after this action accepted it`,
        );
      }
      for (const position of outOfDomainAt) {
        const slug = inserts[position]?.slug;
        if (slug !== undefined) notWritten.add(slug);
      }
      // Only the vetted pages could have been imported; a refused one is
      // reported through neither list, because its slug is the value the
      // domain rule rejected and naming it is the rendering being prevented.
      const imported = vetted.accepted.filter((p) => !notWritten.has(p.slug));
      // Each page inserted maps its file to the id the ingest answered for it.
      // A removed file the site serves is recorded only when the page it is
      // served at is in D1 now, inserted here or already held: otherwise the
      // next publish would delete the text that page is shown with.
      const held = new Set([...Object.keys(ingestBody.insertedPages ?? {}), ...alreadyPresent]);
      const removedRecorded = removedFiles.filter((name) => !(name in servedAt) || held.has(servedAt[name]));
      await recordPagesImport(env.DB, activeProjectId, scanCommit, ingestBody.insertedPages, removedRecorded);

      return {
        ok: vetted.refused.length === 0 && outOfDomainAt.length === 0,
        intent: "import-pages",
        imported: ingestBody.applied?.pageInsert ?? imported.length,
        pages: imported,
        already_present: alreadyPresent,
      };
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageItem {
  id: number;
  title: string;
  slug: string;
  body: string | null;
  order: number;
  _tempId?: string | null;
  _createdBy?: number | null;
  _yIndex?: number;
  /** Fractional index the list sorts by; null on a doc awaiting the backfill. */
  _orderKey?: string | null;
  _yMap?: Y.Map<unknown> | null;
}

interface NavItem {
  type: "page" | "builtin" | "external";
  key?: string;
  slug?: string;
  label: string;
  visible: boolean;
  // Render-only marker for unsaved pages with no slug yet (synthetic nav
  // entries from `mergeNavItemsWithPages`). Never persisted to Yjs.
  _tempId?: string;
}

interface Member {
  userId: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Y.Map helpers
// ---------------------------------------------------------------------------

function readScalar(yMap: Y.Map<unknown>, key: string): string {
  const val = yMap.get(key);
  if (val === null || val === undefined) return "";
  if (val instanceof Y.Text) return val.toString();
  return typeof val === "string" ? val : "";
}

function yMapToPageItem(yMap: Y.Map<unknown>, yIndex: number): PageItem {
  const id = (yMap.get("_id") as number | null) ?? 0;
  const tempId = (yMap.get("_temp_id") as string | null) ?? null;
  const createdBy = (yMap.get("created_by") as number | null) ?? null;
  // The rank, not the ordering: the document carries order_key alone, and the
  // dense `order` D1 column is derived from it at snapshot time. Filled in
  // below from the sorted position, so nothing here has to guess.
  const order = yIndex;

  return {
    id,
    title: readScalar(yMap, "title"),
    slug: (yMap.get("slug") as string) ?? "",
    body: readScalar(yMap, "body"),
    order,
    _tempId: tempId,
    _createdBy: createdBy,
    _yIndex: yIndex,
    _orderKey: readOrderKey(yMap),
    _yMap: yMap,
  };
}

function computeContributors(
  creatorId: number | null,
  currentUserId: number,
  members: Member[]
): string[] {
  const names = new Set<string>();
  if (creatorId && creatorId !== currentUserId) {
    const creator = members.find((m) => m.userId === creatorId);
    if (creator) names.add(creator.name);
  }
  return Array.from(names);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A `scan-repo-pages` that fails in transit is answered unreachable, as the
 * server's own answer to a scan GitHub did not complete is
 * (`answerReadsWhenUnreachable`). Every other intent reaches the server action
 * unchanged.
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  return answerReadsWhenUnreachable(request, serverAction, ["scan-repo-pages"]);
}

/**
 * The answer to a scan that threw. GitHub or the network failing to answer is
 * not an empty repository: it is answered unreachable, and the page says the
 * check could not be made and asks again (`useRetryWhileUnreachable`), where an
 * empty list would stand for the visit. A page file that cannot be read is the
 * same: the scan would otherwise offer less than the repository holds. Every
 * other failure (an empty repository, a refused credential) degrades to the
 * plain empty state.
 */
function scanFailureAnswer(err: unknown) {
  if (isTransientGitHubFailure(err) || err instanceof SheetUnreadableError) {
    return { ok: false as const, reason: "unreachable" as const, intent: "scan-repo-pages" as const, pages: [], warnings: [] };
  }
  return { ok: true as const, intent: "scan-repo-pages" as const, pages: [], warnings: [] };
}

/** The Pages tab scan's answer. */
type ScanAnswer<P> = {
  ok: boolean;
  intent: "scan-repo-pages";
  pages: P[];
  /** The pages found whose bytes are not valid UTF-8, named before any import. */
  warnings?: SheetWarning[];
};

/** The pages a scan found and what it warned of, or none before an answer. */
function scanned<P>(data: ScanAnswer<P> | undefined): { pages: P[]; warnings: SheetWarning[] } {
  if (!data?.ok || data.intent !== "scan-repo-pages") return { pages: [], warnings: [] };
  return { pages: data.pages, warnings: data.warnings ?? [] };
}

/** Whether the scan for importable pages failed where an empty list would otherwise stand. */
function scanCouldNotBeMade(pageCount: number, data: unknown): boolean {
  return pageCount === 0 && isUnreachableAnswer(data);
}

function ScanNotMadeNote({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation("pages");
  if (!failed) return null;
  return (
    <div role="note" className="flex items-center gap-3 font-body text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
      <span>{t("scan_not_made")}</span>
      <button type="button" onClick={onRetry} className="font-semibold underline hover:text-amber-900">
        {t("scan_retry")}
      </button>
    </div>
  );
}

export default function PagesPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("pages");
  const { t: tCommon } = useTranslation("common");
  const {
    project,
    pages: loaderPages,
    members,
    currentUserId,
    userRole,
    landingData,
  } = loaderData;

  const isConvenor = userRole === "convenor";

  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};

  const { ydoc, isPublishing } = useCollaborationContext();
  const ops = useStructuralOps(currentUserId, userRole);
  const { showToast } = useToast();
  const bodyFetcher = useFetcher();

  // ------------------------------------------------------------------
  // Repo-page scan + import on empty state.
  // When displayPages is empty, probe the connected repo for importable
  // pages so the user can pull them into the editor without having to
  // re-import the whole site.
  // ------------------------------------------------------------------
  type ScannedPage = { slug: string; title: string; body: string; order: number };
  const repoScanFetcher = useSiteFetcher<ScanAnswer<ScannedPage>>();
  const importFetcher = useSiteFetcher<{
    ok: boolean;
    intent: "import-pages";
    imported: number;
    pages: ScannedPage[];
    already_present: string[];
  }>();
  const [importingSlugs, setImportingSlugs] = useState<Set<string>>(new Set());
  const repoScanRequestedRef = useRef(false);

  // ------------------------------------------------------------------
  // Source of truth: Yjs when available, loader data otherwise
  // ------------------------------------------------------------------
  const yjsPagesUnsorted = useYjsArraySync(
    ydoc ? ydoc.getArray<Y.Map<unknown>>("pages") : null,
    yMapToPageItem,
  );

  // A page's place is its order_key, not its Y.Array position. `order` is then
  // the rank in that order — the same number the snapshot writes to D1 — so the
  // two never disagree about what "third page" means. The `_yIndex` tie-break
  // keeps the sort total for a document the backfill has not reached yet.
  const yjsPages = useMemo(
    () =>
      yjsPagesUnsorted === null
        ? null
        : [...yjsPagesUnsorted]
            .sort(compareByOrderKey)
            .map((p, i) => ({ ...p, order: i })),
    [yjsPagesUnsorted],
  );

  const useYjs = ydoc !== null && ops !== null && yjsPages !== null;
  const displayPages: PageItem[] = useYjs
    ? yjsPages!
    : (loaderPages as PageItem[]);

  // ------------------------------------------------------------------
  // Probe the repo for importable pages on first
  // render WHEN displayPages is empty. Mount-trigger pattern mirrors
  // _app.objects.tsx:1347-1350. Guarded by ref to avoid re-firing.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (repoScanRequestedRef.current) return;
    if (displayPages.length > 0) return;
    repoScanRequestedRef.current = true;
    repoScanFetcher.submit({ intent: "scan-repo-pages" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPages.length]);

  // A scan that failed in transit is asked again while the list is empty, so
  // the import banner appears once the connection returns.
  useRetryWhileUnreachable(
    repoScanFetcher.data,
    () => repoScanFetcher.submit({ intent: "scan-repo-pages" }, { method: "post" }),
    displayPages.length === 0,
  );

  // ------------------------------------------------------------------
  // Clear the per-row spinners once the import action answers.
  //
  // There is no mirror-into-Yjs step here: the action posts the pages to the
  // collaboration DO, which appends them to the shared document and broadcasts
  // the new state, so the tab hydrates over the socket like any other edit.
  // Writing them locally as well would push a second Y.Map for each slug and
  // hand the snapshot's dedupe pass a collision to resolve.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (importFetcher.state !== "idle") return;
    const data = importFetcher.data;
    if (!data || data.intent !== "import-pages") return;
    setImportingSlugs(new Set());
    // The layout's notice speaks for an import refused because the site
    // changed.
    if (!data.ok && !isSiteChanged(data)) {
      // The repo scan or the ingest failed. Clear the spinners so the import
      // banner is retryable rather than stuck, and surface a generic error
      // toast — the import is idempotent by slug, so a retry is safe.
      showToast({ message: tCommon("error"), type: "destructive" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importFetcher.state, importFetcher.data]);

  // Handlers for the import variant.
  function handleImportAll() {
    const pages = repoScanFetcher.data?.pages ?? [];
    setImportingSlugs(new Set(pages.map((p) => p.slug)));
    importFetcher.submit({ intent: "import-pages" }, { method: "post" });
  }

  function handleImportOne(slug: string) {
    setImportingSlugs((prev) => {
      const next = new Set(prev);
      next.add(slug);
      return next;
    });
    const form = new FormData();
    form.set("intent", "import-pages");
    form.append("slugs", slug);
    importFetcher.submit(form, { method: "post" });
  }

  // Stable dnd-kit identifier — see `app/lib/item-key.ts` for the rationale
  // (key must remain constant across snapshotToD1's `_id` backfill, otherwise
  // the remote-delete observer below fires a false toast).

  // ------------------------------------------------------------------
  // Navigation array from Yjs config (for the nav bar preview)
  // ------------------------------------------------------------------
  const [navItems, setNavItems] = useState<NavItem[]>([]);

  useEffect(() => {
    if (!ydoc) return;
    const config = ydoc.getMap("config");

    const recomputeNav = () => {
      const navArray = config.get("navigation");
      if (navArray instanceof Y.Array) {
        // sanitizeNavArray filters out empty Y.Maps and entries with missing
        // required fields (legacy corruption recovery — guards against a
        // pages-reorder regression where entries could vanish).
        // When dropped > 0, the helper also rewrites navArray inside a
        // transact so the next snapshot persists the cleaned shape.
        const { items } = sanitizeNavArray(navArray, { mutate: true, ydoc });
        setNavItems(items as NavItem[]);
      }
    };
    recomputeNav();
    config.observeDeep(recomputeNav);
    return () => config.unobserveDeep(recomputeNav);
  }, [ydoc]);

  // ------------------------------------------------------------------
  // Follow a Durable Object re-key through the nav array.
  //
  // A nav entry addresses its page by slug alone. When two members rename
  // their pages onto one free slug, the DO keeps both pages by re-keying the
  // loser (`deduplicateYArray`), which moves a slug the menu still holds the
  // old value of: the keeper gets two entries, the re-keyed page none. The
  // published menu comes from `config.navigation` via `navigation_json`, so
  // the stale copy is what ships — and this route is the only place holding
  // both the page list and the nav array, which is what the repair needs.
  // ------------------------------------------------------------------
  // The dependency is the repair's own signature, not a field list written out
  // here: a hand-kept copy of what the function reads drifts from it, and the
  // drift is invisible — the repair simply does not run on the change it
  // missed, and a re-keyed page stays unlinked until something else re-runs it.
  const navReconcileDep = useMemo(
    () => navReconcileSignature(displayPages, navItems),
    [displayPages, navItems],
  );

  useEffect(() => {
    if (!ydoc || !useYjs) return;
    const navArray = ydoc.getMap("config").get("navigation");
    if (!(navArray instanceof Y.Array)) return;
    reconcileNavPageSlugs(
      navArray,
      displayPages.map((p) => ({ slug: p.slug, title: p.title })),
      { mutate: true, ydoc },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, useYjs, navReconcileDep]);

  // Site title from Yjs config
  const [siteTitle, setSiteTitle] = useState("");

  useEffect(() => {
    if (!ydoc) return;
    const config = ydoc.getMap("config");

    const recomputeTitle = () => {
      const titleVal = config.get("title");
      if (titleVal instanceof Y.Text) {
        setSiteTitle(titleVal.toString());
      } else if (typeof titleVal === "string") {
        setSiteTitle(titleVal);
      }
    };
    recomputeTitle();
    config.observeDeep(recomputeTitle);
    return () => config.unobserveDeep(recomputeTitle);
  }, [ydoc]);

  // ------------------------------------------------------------------
  // Selected row state. The pinned Home row (HOME_ROW_KEY) is the default
  // the right pane opens on the landing editor. /pages/index
  // deep-links also focus Home (the redirect lands here). Selecting a content
  // page swaps the pane to the standard page editor.
  // ------------------------------------------------------------------
  const [selectedKey, setSelectedKey] = useState<string | null>(HOME_ROW_KEY);

  useEffect(() => {
    // If the selected content page disappears (deleted locally or remotely),
    // fall back to the pinned Home row rather than stranding an empty pane.
    if (
      selectedKey !== null &&
      selectedKey !== HOME_ROW_KEY &&
      !displayPages.some((p) => keyFor(p) === selectedKey)
    ) {
      setSelectedKey(HOME_ROW_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPages]);

  const isHomeSelected = selectedKey === HOME_ROW_KEY;
  const selectedPage = !isHomeSelected && selectedKey
    ? displayPages.find((p) => keyFor(p) === selectedKey) ?? null
    : null;

  // Derived set of pages with empty/whitespace titles. Used to flag
  // both the title-field error state and the sidebar incomplete badge. NOT React
  // state and NOT Yjs state — the page row stays in Yjs/D1 even when the
  // title is empty, so the user keeps their work-in-progress.
  const incompletePageKeys = useMemo(
    () => new Set(displayPages.filter((p) => !(p.title ?? "").trim()).map(keyFor)),
    // keyFor is referentially stable across renders (defined inline but pure of
    // closure state); the Set only needs to be recomputed when displayPages
    // identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayPages],
  );

  // Track last length to detect newly created pages (auto-select new page)
  const prevLengthRef = useRef(displayPages.length);
  useEffect(() => {
    if (displayPages.length > prevLengthRef.current) {
      const last = displayPages[displayPages.length - 1];
      if (last) setSelectedKey(keyFor(last));
    }
    prevLengthRef.current = displayPages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPages.length]);

  // Resolve Y.Map and Y.Text for the selected page (supports new pages with _temp_id)
  const pagesArray = ydoc?.getArray<Y.Map<unknown>>("pages") ?? null;
  const selectedPageYMap = pagesArray && selectedPage
    ? findYMapByIdOrTempId(
        pagesArray,
        selectedPage.id > 0 ? selectedPage.id : null,
        selectedPage._tempId ?? null
      )
    : null;
  const pageTitleYText = getYText(selectedPageYMap, "title");
  const pageBodyYText = getYText(selectedPageYMap, "body");

  // ------------------------------------------------------------------
  // Deferred slug generation — auto-generate from title when user edits it
  // ------------------------------------------------------------------
  const prevTitleForSlugRef = useRef<Map<string, string>>(new Map());
  // Per-page debounce timers. The auto-slug effect fires on every Y.Text
  // keystroke; without debouncing, the first character of the title locks
  // the URL (e.g. typing "page" produced /p/ and froze, because by the time
  // "a" arrived the slug was no longer the temp placeholder).
  const slugDebounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const SLUG_DEBOUNCE_MS = 600;

  useEffect(() => {
    if (!useYjs || !ydoc) return;
    for (const page of displayPages) {
      const key = keyFor(page);
      const prevTitle = prevTitleForSlugRef.current.get(key);
      // Fire whenever the title changes AND the page has a non-empty title.
      // The actual write runs after SLUG_DEBOUNCE_MS of no further changes,
      // re-reads live state from the Y.Doc, then branches on the slug:
      //   - empty / `untitled-N` placeholder → derive new slug from title,
      //     update slug AND push or update the navArray entry with label.
      //   - real slug → leave the slug alone, only sync the navArray label
      //     (with a customisation guard so we don't clobber a label set by
      //     the NavigationEditor).
      if (
        prevTitle !== undefined &&
        prevTitle !== page.title &&
        page.title
      ) {
        const existing = slugDebounceRef.current.get(key);
        if (existing) clearTimeout(existing);
        const pageId = page.id > 0 ? page.id : null;
        const pageTempId = page._tempId ?? null;
        const previousTitleSnapshot = prevTitle;
        const timer = setTimeout(() => {
          slugDebounceRef.current.delete(key);
          if (!ydoc) return;
          const pArr = ydoc.getArray<Y.Map<unknown>>("pages");
          const targetYMap = findYMapByIdOrTempId(pArr, pageId, pageTempId);
          if (!targetYMap) return;
          const titleY = targetYMap.get("title");
          const currentTitle =
            titleY instanceof Y.Text ? titleY.toString() : "";
          if (!currentTitle) return; // user cleared the title before the timer fired
          const currentSlug = (targetYMap.get("slug") as string) ?? "";
          const config = ydoc.getMap("config");
          const navArray = config.get("navigation");

          if (!currentSlug || isTemporaryPageSlug(currentSlug)) {
            // Slug derivation path — generate from title and push/update nav.
            const allSlugs = new Set<string>();
            for (let i = 0; i < pArr.length; i++) {
              const s = pArr.get(i).get("slug") as string;
              if (s && s !== currentSlug) allSlugs.add(s);
            }
            const { slug: newSlug } = makeUniqueSlug(
              normaliseSlug(currentTitle),
              allSlugs
            );
            ydoc.transact(() => {
              targetYMap.set("slug", newSlug);
              if (navArray instanceof Y.Array) {
                let updated = false;
                if (currentSlug) {
                  for (let i = 0; i < navArray.length; i++) {
                    const item = navArray.get(i) as Record<string, unknown> | null;
                    if (item && item.type === "page" && item.slug === currentSlug) {
                      navArray.delete(i, 1);
                      navArray.insert(i, [
                        { ...item, slug: newSlug, label: currentTitle },
                      ]);
                      updated = true;
                      break;
                    }
                  }
                }
                if (!updated) {
                  navArray.push([
                    {
                      type: "page",
                      slug: newSlug,
                      label: currentTitle,
                      visible: true,
                    },
                  ]);
                }
              }
            });
            return;
          }

          // Label-sync path — slug is real, just update the nav label so the
          // published navigation.yml stays in sync with the page title.
          // Customisation guard: only update if the existing label equals
          // the previously-observed title (i.e. it was tracking the title).
          // If NavigationEditor changed it to something else, leave alone.
          if (!(navArray instanceof Y.Array)) return;
          ydoc.transact(() => {
            for (let i = 0; i < navArray.length; i++) {
              const item = navArray.get(i) as Record<string, unknown> | null;
              if (item && item.type === "page" && item.slug === currentSlug) {
                const currentLabel =
                  typeof item.label === "string" ? item.label : "";
                if (
                  currentLabel === previousTitleSnapshot &&
                  currentLabel !== currentTitle
                ) {
                  navArray.delete(i, 1);
                  navArray.insert(i, [{ ...item, label: currentTitle }]);
                }
                break;
              }
            }
          });
        }, SLUG_DEBOUNCE_MS);
        slugDebounceRef.current.set(key, timer);
      }
      prevTitleForSlugRef.current.set(key, page.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPages, useYjs]);

  // Clear any pending slug debounce timers on unmount so they don't fire
  // against a stale ydoc.
  useEffect(() => {
    return () => {
      for (const timer of slugDebounceRef.current.values()) clearTimeout(timer);
      slugDebounceRef.current.clear();
    };
  }, []);

  // ------------------------------------------------------------------
  // Slug change handler — writes to Yjs + updates navigation array
  // ------------------------------------------------------------------
  const handleSlugChange = useCallback(
    (newSlug: string) => {
      if (!ydoc || !selectedPage) return;
      const pArr = ydoc.getArray<Y.Map<unknown>>("pages");
      const targetYMap = findYMapByIdOrTempId(
        pArr,
        selectedPage.id > 0 ? selectedPage.id : null,
        selectedPage._tempId ?? null
      );
      if (!targetYMap) return;

      const oldSlug = targetYMap.get("slug") as string;
      ydoc.transact(() => {
        targetYMap.set("slug", newSlug);
        const config = ydoc.getMap("config");
        const navArray = config.get("navigation") as unknown;
        if (navArray instanceof Y.Array) {
          for (let i = 0; i < navArray.length; i++) {
            const item = navArray.get(i) as Record<string, unknown>;
            if (item.type === "page" && item.slug === oldSlug) {
              const updated = { ...item, slug: newSlug };
              navArray.delete(i, 1);
              navArray.insert(i, [updated]);
              break;
            }
          }
        }
      });
    },
    [ydoc, selectedPage]
  );

  // Build existingSlugs for the slug field (all pages except the selected one)
  const existingSlugs = new Set(
    displayPages
      .filter((p) => keyFor(p) !== selectedKey)
      .map((p) => p.slug)
      .filter(Boolean)
  );

  // ------------------------------------------------------------------
  // Nav bar: build sortable items from the Yjs navigation array
  // Fallback to defaults for projects created before the navigation array
  // ------------------------------------------------------------------

  const defaultNavItems: NavItem[] = [
    { type: "builtin", key: "home", label: "Home", visible: true },
    { type: "builtin", key: "collection", label: "Objects", visible: true },
    { type: "builtin", key: "glossary", label: "Glossary", visible: true },
  ];

  // Merge persisted nav items with displayPages so newly-created pages always
  // get a tab — including untitled pages (no slug yet) which the renderer keys
  // by `_tempId` until the user types a title and the slug auto-generates. The
  // previous all-or-nothing fallback ignored `displayPages` whenever navItems
  // had any entries, leaving new pages reachable from `pagesArray` but with no
  // tab to click.
  const baseNavItems = navItems.length > 0 ? navItems : defaultNavItems;
  // The sidebar lists every page that can be selected. The publish writes
  // saved entries only, so the menu preview leaves the added ones out
  // (`menuPreviewEntries`).
  const effectiveNavItems = mergeNavItemsWithPages(baseNavItems, displayPages, {
    untitledLabel: t("untitled"),
  });

  // Each nav item gets a stable sortable ID
  const navSortableId = (item: NavItem, idx: number): string => {
    if (item.type === "builtin") return `nav-builtin-${item.key}`;
    if (item.type === "page") {
      if (item.slug) return `nav-page-${item.slug}`;
      if (item._tempId) return `nav-page-temp-${item._tempId}`;
      return `nav-page-${idx}`;
    }
    return `nav-${idx}`;
  };

  // Map page slugs to page keys for selection
  const pageBySlug = new Map(displayPages.map((p) => [p.slug, p]));

  const navSortableIds = effectiveNavItems.map((item, i) => navSortableId(item, i));

  // ------------------------------------------------------------------
  // Two-surface derivation from the single navigation_json array.
  //
  // Nav simulator view: the full menu MINUS untitled pages. Untitled pages
  // can't be published, so they must not preview in the live menu.
  // Built-ins always render here.
  //
  // "Untitled" is keyed off the resolved page's empty TITLE — the same test the
  // sidebar uses (line ~829) — not off a missing slug. A freshly-added page
  // carries a placeholder slug ("untitled"/"untitled-N") while its title is
  // still blank, so a slug-only check let it leak into the simulator with a
  // warning badge (UAT G1). A slug that resolves to no page is left as-is.
  //
  // Sidebar view: content (titled) page rows are sortable; untitled page rows
  // are listed but excluded from the sortable axis so they are
  // never reorder targets in the shared array.
  // ------------------------------------------------------------------
  const isUntitledPageItem = (item: NavItem): boolean => {
    if (item.type !== "page") return false;
    const page = item.slug
      ? pageBySlug.get(item.slug)
      : item._tempId
        ? displayPages.find((p) => p._tempId === item._tempId)
        : undefined;
    if (!page) return !item.slug;
    return !(page.title ?? "").trim();
  };
  const navSimItems = menuPreviewEntries(baseNavItems, effectiveNavItems, isUntitledPageItem);
  const navSimSortableIds = navSimItems.map((item, i) => navSortableId(item, i));

  /** Whether this member may delete a page. */
  const canDeletePage = (page: PageItem): boolean =>
    useYjs && !!page._yMap && ops!.canDelete(page._yMap);

  // One row per page entry, in menu order (`buildSidebarRows`);
  // `sidebarIdToFullIdx` maps each sortable row to its entry's index in the
  // FULL menu, which is its index in the live navArray.
  const { contentRows, untitledRows, sidebarIdToFullIdx } = buildSidebarRows({
    items: effectiveNavItems,
    pages: displayPages,
    sortableId: navSortableId,
    canDelete: canDeletePage,
  });

  // Builtin labels
  const builtinLabels: Record<string, string> = {
    home: t("nav_home"),
    collection: t("nav_objects"),
    glossary: t("nav_glossary"),
  };

  // DnD sensors
  const sensors = useSortableSensors();

  // ------------------------------------------------------------------
  // Delete confirmation modal state
  // ------------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = useState<{
    page: PageItem;
    contributors: string[];
  } | null>(null);

  function openDeleteModalFor(page: PageItem) {
    const contributors = computeContributors(page._createdBy ?? null, currentUserId, members as Member[]);
    setDeleteTarget({ page, contributors });
  }

  // The page goes in one transaction and the menu entry naming it in a
  // second, as a page's entry always has.
  function confirmDelete() {
    if (!deleteTarget) return;
    const { page } = deleteTarget;
    if (useYjs) {
      ops!.deletePage(page.id > 0 ? page.id : null, page._tempId ?? null);
      if (ydoc && page.slug) removeNavEntries(ydoc, [page.slug]);
    }
    setDeleteTarget(null);
  }

  // Remote-delete toast — fires when a page disappears from the Y.Array
  // because a peer removed it. Shared logic in useRemoteDeleteToast.
  useRemoteDeleteToast({
    items: displayPages,
    enabled: useYjs,
    scope: ydoc,
    getLabel: (p) => p.title || p.slug,
  });

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  function handleNavDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !ydoc) return;

    // The nav simulator renders `navSimItems` (untitled pages excluded), but
    // indices must resolve against the FULL navigation array. Look the dragged
    // and target sortable ids up in `navSortableIds` (full array order).
    const oldIndex = navSortableIds.indexOf(String(active.id));
    const newIndex = navSortableIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const config = ydoc.getMap("config");
    const navArray = config.get("navigation");
    if (!(navArray instanceof Y.Array)) return;

    // Merge-only entries (untitled pages with `_tempId` only, or temp-slug
    // pages whose nav entry hasn't been pushed yet) live in `effectiveNavItems`
    // past the end of `navArray`. Skip the persisted reorder for them rather
    // than corrupt indices into `navArray`. Untitled pages are also excluded
    // from the nav simulator now, so this guard mainly protects the
    // brief window before a freshly-titled page's nav entry is pushed.
    if (oldIndex >= navArray.length || newIndex >= navArray.length) return;

    // navigation_json is the SOLE ordering
    // authority. Reorder ONLY the nav array — the redundant `pages`-array
    // reorder (ops.reorderPages) was removed because the published menu order
    // derives solely from navigation_json (publish.server.ts:64,190) and the
    // `pages` array `order` field is editor-only, not the published authority.
    ydoc.transact(() => {
      reorderNavArray(navArray, oldIndex, newIndex);
    });
  }

  // Sidebar reorder. The sidebar renders a filtered
  // subset (titled content pages only), so its index space differs from the
  // full nav array. `sidebarIdToFullIdx` translates each sortable id back to
  // its full-array index; untitled rows have no entry and bail.
  function handleSidebarDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !ydoc) return;

    const oldFullIdx = sidebarIdToFullIdx.get(String(active.id));
    const newFullIdx = sidebarIdToFullIdx.get(String(over.id));
    if (oldFullIdx == null || newFullIdx == null) return; // untitled rows excluded

    const config = ydoc.getMap("config");
    const navArray = config.get("navigation");
    if (!(navArray instanceof Y.Array)) return;
    if (oldFullIdx >= navArray.length || newFullIdx >= navArray.length) return;

    // Single move within the shared array — built-in slots are untouched
    // because only the dragged page's entry moves. No ops.reorderPages call.
    ydoc.transact(() => reorderNavArray(navArray, oldFullIdx, newFullIdx));
  }

  // Resolve a content/untitled sidebar row's selection key to its PageItem,
  // then route to the existing delete-modal flow (preserves contributor
  // attribution + canDelete gating).
  function handleSidebarDelete(selectKey: string) {
    const page = displayPages.find((p) => keyFor(p) === selectKey);
    if (page) handleDeleteClick(page);
  }

  function handleCreatePage() {
    if (useYjs) {
      ops!.addPage();
    }
  }

  function handleDeleteClick(page: PageItem) {
    if (!canDeletePage(page)) return;
    openDeleteModalFor(page);
  }

  const canDeleteSelected = selectedPage
    ? useYjs
      ? selectedPage._yMap
        ? ops!.canDelete(selectedPage._yMap)
        : userRole === "convenor"
      : true
    : false;

  const publishLock = isPublishing ? "opacity-50 pointer-events-none" : "";

  void bodyFetcher;
  void canDeleteSelected;

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  // Repo-import recovery banner: when there are no content pages yet but the
  // connected repo has importable pages, offer to pull them in. Rendered ABOVE
  // the two-column shell (rather than replacing the whole view) so the pinned
  // Home row stays editable in-place.
  const { pages: scannedPages, warnings: scanWarnings } = scanned(repoScanFetcher.data);
  const showImportVariant = displayPages.length === 0 && scannedPages.length > 0;
  // The scan could not be made: an empty list is not the answer.
  const scanFailed = scanCouldNotBeMade(displayPages.length, repoScanFetcher.data);

  return (
    <div className={`flex flex-col ${publishLock}`}>
      {/* Instructional copy */}
      <div className="px-6 pt-4 pb-2 space-y-2 max-w-2xl">
        <p className="font-body text-sm text-gray-500">
          {t("nav_bar_intro")}{" "}
          <a href="https://telar.org/docs/site-features/custom-pages/" target="_blank" rel="noopener noreferrer" className="text-terracotta hover:text-terracotta/80 underline">{t("learn_more")}</a>.
        </p>
        <p className="font-body text-sm text-gray-500">{t("nav_bar_instructions")}</p>
        {openDoc && <DocsLink docId="pages" onOpenDoc={openDoc} />}
        <ScanNotMadeNote
          failed={scanFailed}
          onRetry={() => repoScanFetcher.submit({ intent: "scan-repo-pages" }, { method: "post" })}
        />
      </div>

      {/* Repo-import recovery banner (only when no content pages exist yet) */}
      {showImportVariant && (
        <div className="mx-6 mb-2">
          <PagesRepoImportEmptyState
            pages={scannedPages.map((p) => ({ slug: p.slug, title: p.title }))}
            warnings={scanWarnings}
            onImportAll={handleImportAll}
            onImportOne={handleImportOne}
            isImporting={importFetcher.state !== "idle"}
            importingSlugs={importingSlugs}
          />
        </div>
      )}

      {/* Nav bar preview — the navigation-menu simulator, kept above the
          two-column block. Renders the FULL published menu (built-ins + titled
          pages) MINUS untitled pages, which can't be published. */}
      <div className="mx-6 border border-gray-200 rounded-lg bg-white overflow-x-auto">
        <div className="flex items-center h-[44px] px-4 min-w-max">
          {/* Site title — left */}
          <span className="font-heading text-xl font-semibold text-gray-300 mr-auto">
            {siteTitle || t("nav_site_title_placeholder")}
          </span>

          {/* Nav items — right-aligned, all draggable */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleNavDragEnd}
          >
            <SortableContext items={navSimSortableIds} strategy={horizontalListSortingStrategy}>
              {navSimItems.map((item, idx) => {
                const sid = navSortableId(item, idx);
                if (item.type === "builtin") {
                  return (
                    <SortablePageTab
                      key={sid}
                      sortableId={sid}
                      label={builtinLabels[item.key!] ?? item.label}
                      isSelected={false}
                      onSelect={() => {}}
                      isBuiltin
                    />
                  );
                }
                if (item.type === "page") {
                  // Nav-sim entries are always titled pages now (untitled are
                  // excluded above), resolved by slug.
                  const page = item.slug ? pageBySlug.get(item.slug) : undefined;
                  const key = page ? keyFor(page) : sid;
                  return (
                    <SortablePageTab
                      key={sid}
                      sortableId={sid}
                      label={page?.title?.trim() || item.label || t("untitled")}
                      isSelected={page ? key === selectedKey : false}
                      onSelect={() => { if (page) setSelectedKey(keyFor(page)); }}
                      onDelete={page ? () => handleDeleteClick(page) : undefined}
                      canDelete={page ? canDeletePage(page) : false}
                      isIncomplete={page ? incompletePageKeys.has(keyFor(page)) : false}
                    />
                  );
                }
                return null;
              })}
            </SortableContext>
          </DndContext>

          {/* Share placeholder — matches Telar navbar share button */}
          <div className="ml-2 px-3 h-[28px] flex items-center gap-1.5 rounded-full border border-gray-200 text-gray-300">
            <Upload className="w-3.5 h-3.5" />
            <span className="font-body text-xs">{t("nav_share")}</span>
          </div>
        </div>
      </div>

      {/* Two-column shell — left editing sidebar + right editor pane.
          Mirrors the glossary aside+main composition (_app.glossary.tsx:469-535). */}
      <div className="flex h-[calc(100dvh-260px)] mx-6 mt-4 mb-6 bg-white rounded-lg shadow-sm overflow-hidden">
        <PagesSidebar
          contentRows={contentRows}
          untitledRows={untitledRows}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          onDelete={handleSidebarDelete}
          onAddPage={handleCreatePage}
          onDragEnd={handleSidebarDragEnd}
          sensors={sensors}
          isConvenor={isConvenor}
          canAdd={useYjs}
        />

        <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-cream">
          {isHomeSelected ? (
            // Pinned Home row: the shared landing editor, in-place.
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
              <HomepageEditor data={landingData} />
            </div>
          ) : !selectedPage ? (
            <div className="flex items-center justify-center flex-1">
              <p className="font-body text-sm text-gray-400">{t("empty_editor")}</p>
            </div>
          ) : (
            <>
              {/* PAGE TITLE section */}
              <div className="px-6 pt-6 pb-4 shrink-0">
                <label className="block font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  {t("title_label")}
                </label>
                <InlineTextField
                  initialValue={selectedPage.title}
                  yText={pageTitleYText}
                  placeholder={t("title_placeholder")}
                  className="w-full px-4 py-2 font-heading font-semibold text-lg border border-gray-200 rounded-lg bg-surface hover:border-gray-300 focus:border-anil-deep"
                  fieldKey={`page-${selectedKey}-title`}
                  error={!(selectedPage.title ?? "").trim()}
                  errorMessage={t("name_required")}
                />
                {/* Slug — label + field appear once slug is generated */}
                {selectedPage.slug ? (
                  <div className="mt-4">
                    <label className="block font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      {t("slug_label")}
                    </label>
                    <SlugField
                      slug={selectedPage.slug}
                      existingSlugs={existingSlugs}
                      onSlugChange={handleSlugChange}
                    />
                  </div>
                ) : null}
              </div>

              {/* CONTENT section — fills remaining height */}
              <div className="flex-1 min-h-0 flex flex-col px-6 pb-4">
                <label className="block font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 shrink-0">
                  {t("content_label")}
                </label>
                <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-gray-200 bg-surface">
                  <MarkdownEditor
                    key={`page-body-${selectedKey}`}
                    initialValue={selectedPage.body ?? ""}
                    fieldName="body"
                    projectId={selectedPage.id}
                    intent="autosave-page-body"
                    actionUrl="/pages"
                    yText={pageBodyYText}
                    className="h-full flex flex-col"
                    transparent
                    alwaysShowToolbar
                    enableGlossaryLinks
                  />
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {/* Centralised delete confirmation */}
      <DeleteConfirmationModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        entityType="page"
        entityLabel={deleteTarget?.page.title || deleteTarget?.page.slug || ""}
        contributors={deleteTarget?.contributors}
      />
    </div>
  );
}
