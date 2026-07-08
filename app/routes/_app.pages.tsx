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
 * @version v1.4.1-beta
 */

import { asc, eq, and } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher, useOutletContext } from "react-router";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as Y from "yjs";
import { decrypt } from "~/lib/crypto.server";
import { scanRepoPages } from "~/lib/import.server";
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
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
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
import { useToast } from "~/hooks/use-toast";
import { keyFor } from "~/lib/item-key";
import { useRemoteDeleteToast } from "~/hooks/use-remote-delete-toast";
import { mergeNavItemsWithPages } from "~/lib/nav-merge";
import { findYMapByIdOrTempId, getYText, reorderNavArray, sanitizeNavArray } from "~/lib/yjs-helpers";
import { HomepageEditor } from "~/components/features/pages/HomepageEditor";
import { PagesSidebar, HOME_ROW_KEY, type PagesSidebarRow } from "~/components/features/pages/PagesSidebar";
import { loadHomepageEditorData } from "~/lib/homepage-editor-data.server";

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

  const pages = await db
    .select()
    .from(project_pages)
    .where(eq(project_pages.project_id, activeProject.id))
    .orderBy(asc(project_pages.order));

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

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    throw new Response("Not found", { status: 404 });
  }
  const { project: activeProject } = resolved;
  const activeProjectId = activeProject.id;

  switch (intent) {
    case "autosave-page-body": {
      const pageId = Number(formData.get("projectId"));
      const value = formData.get("value") as string;
      if (!pageId || value === null) throw new Response("Bad request", { status: 400 });

      const bodyPageRows = await db
        .select({ id: project_pages.id })
        .from(project_pages)
        .where(and(eq(project_pages.id, pageId), eq(project_pages.project_id, activeProjectId)))
        .limit(1);

      if (bodyPageRows.length === 0) throw new Response("Not found", { status: 404 });

      await db
        .update(project_pages)
        .set({ body: value, updated_at: new Date().toISOString() })
        .where(eq(project_pages.id, pageId));

      return { ok: true, intent: "autosave-page-body" };
    }

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
        // warns about.
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const pages = await scanRepoPages(token, owner, repo);
        return { ok: true, intent: "scan-repo-pages", pages };
      } catch (err) {
        console.error("scan-repo-pages failed; degrading to empty state:", err);
        return { ok: true, intent: "scan-repo-pages", pages: [] };
      }
    }

    case "import-pages": {
      // Insert one or more discovered pages into D1 for the active project.
      // Slugs may be filtered via repeated `slugs` form fields; omitting them
      // imports every page returned by scanRepoPages. Slugs that already exist
      // in D1 are skipped (no overwrite — drift handling is out of scope per
      // and reported in `already_present` so the UI can surface
      // them. The client effect mirrors the returned `pages` into the active
      // Yjs document so the editor hydrates immediately.
      const requestedSlugs = formData.getAll("slugs").map((s) => String(s));
      // Same fail-open guard as scan-repo-pages: getRepoTree throws on a
      // non-2xx (e.g. an empty repo's tree 404s), and decrypt throws on a
      // corrupted token. This action is user-initiated and only reachable
      // after a successful scan, so a throw here is a rare transient — but an
      // uncaught one still white-screens the tab. Return a structured failure
      // so the client can clear its spinners and toast.
      let allPages: Awaited<ReturnType<typeof scanRepoPages>>;
      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        allPages = await scanRepoPages(token, owner, repo);
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

      // Skip slugs that are already in D1 — never overwrite existing pages.
      const existingPages = await db
        .select({ slug: project_pages.slug })
        .from(project_pages)
        .where(eq(project_pages.project_id, activeProjectId));
      const existingSlugs = new Set(existingPages.map((p) => p.slug));

      const toInsert = candidatePages.filter((p) => !existingSlugs.has(p.slug));
      const alreadyPresent = candidatePages
        .filter((p) => existingSlugs.has(p.slug))
        .map((p) => p.slug);

      const now = new Date().toISOString();
      // Capture each inserted row's real D1 id so the client mirrors the Y.Map
      // with that `_id` (not null). A null `_id` would make the next snapshot
      // INSERT a second row with the same slug → UNIQUE(project_id, slug) clash.
      const insertedIdBySlug: Record<string, number> = {};
      for (const page of toInsert) {
        const [row] = await db
          .insert(project_pages)
          .values({
            project_id: activeProjectId,
            title: page.title,
            slug: page.slug,
            body: page.body,
            order: page.order,
            created_by: user.id,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: project_pages.id });
        if (row) insertedIdBySlug[page.slug] = row.id;
      }

      return {
        ok: true,
        intent: "import-pages",
        imported: toInsert.length,
        pages: toInsert,
        already_present: alreadyPresent,
        insertedIdBySlug,
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
  const order = typeof yMap.get("order") === "number"
    ? (yMap.get("order") as number)
    : yIndex;

  return {
    id,
    title: readScalar(yMap, "title"),
    slug: (yMap.get("slug") as string) ?? "",
    body: readScalar(yMap, "body"),
    order,
    _tempId: tempId,
    _createdBy: createdBy,
    _yIndex: yIndex,
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
  const repoScanFetcher = useFetcher<{
    ok: boolean;
    intent: "scan-repo-pages";
    pages: ScannedPage[];
  }>();
  const importFetcher = useFetcher<{
    ok: boolean;
    intent: "import-pages";
    imported: number;
    pages: ScannedPage[];
    already_present: string[];
    insertedIdBySlug?: Record<string, number>;
  }>();
  const [importingSlugs, setImportingSlugs] = useState<Set<string>>(new Set());
  const repoScanRequestedRef = useRef(false);

  // ------------------------------------------------------------------
  // Source of truth: Yjs when available, loader data otherwise
  // ------------------------------------------------------------------
  const yjsPages = useYjsArraySync(
    ydoc ? ydoc.getArray<Y.Map<unknown>>("pages") : null,
    yMapToPageItem,
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

  // ------------------------------------------------------------------
  // When the import action returns, mirror the imported page
  // records into the active Yjs document. The page rows already landed in
  // D1 via the action; mirroring into Yjs hydrates the editor immediately
  // so the user does not need to reload. Mirrors the addPage shape from
  // use-structural-ops.ts:309-331.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (importFetcher.state !== "idle") return;
    const data = importFetcher.data;
    if (!data || data.intent !== "import-pages") return;
    if (!data.ok) {
      // The action's repo scan failed (e.g. the repo tree 404'd). Clear the
      // per-row spinners so the import banner is retryable rather than stuck,
      // and surface a generic error toast.
      setImportingSlugs(new Set());
      showToast({ message: tCommon("error"), type: "destructive" });
      return;
    }
    if (!ydoc || data.pages.length === 0) return;
    const pagesArray = ydoc.getArray<Y.Map<unknown>>("pages");
    // Skip pages already in Yjs (defensive: D1 already gates duplicates;
    // this guards against a race where Yjs received the same slug between
    // the import POST landing and the response arriving here).
    const existingSlugs = new Set<string>();
    for (let i = 0; i < pagesArray.length; i++) {
      const s = pagesArray.get(i).get("slug") as string;
      if (s) existingSlugs.add(s);
    }
    ydoc.transact(() => {
      for (const page of data.pages) {
        if (existingSlugs.has(page.slug)) continue;
        const pageMap = new Y.Map<unknown>();
        // Mirror with the real D1 id so the snapshot UPDATEs this row instead of
        // INSERTing a duplicate slug (which would clash on UNIQUE(project_id, slug)).
        pageMap.set("_id", data.insertedIdBySlug?.[page.slug] ?? null);
        pageMap.set("_temp_id", crypto.randomUUID());
        pageMap.set("created_by", currentUserId);
        const titleY = new Y.Text();
        titleY.insert(0, page.title);
        pageMap.set("title", titleY);
        pageMap.set("slug", page.slug);
        const bodyY = new Y.Text();
        bodyY.insert(0, page.body);
        pageMap.set("body", bodyY);
        pageMap.set("order", pagesArray.length);
        pagesArray.push([pageMap]);
      }
    });
    setImportingSlugs(new Set());
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
  const navSimItems = effectiveNavItems.filter((item) => !isUntitledPageItem(item));
  const navSimSortableIds = navSimItems.map((item, i) => navSortableId(item, i));

  // sidebarIdToFullIdx: each titled content page's sidebar sortable id →
  // its index in the FULL effectiveNavItems array (== its index in the live
  // navArray for persisted entries). Untitled pages get NO entry here, so a
  // drag involving them resolves to null and is bailed.
  const sidebarIdToFullIdx = new Map<string, number>();
  const contentRows: PagesSidebarRow[] = [];
  const untitledRows: PagesSidebarRow[] = [];

  for (let fullIdx = 0; fullIdx < effectiveNavItems.length; fullIdx++) {
    const item = effectiveNavItems[fullIdx];
    if (item.type !== "page") continue;

    // Resolve the underlying page (by slug for persisted entries, by _tempId
    // for synthetic untitled entries) to derive the stable selection key.
    const page = item.slug
      ? pageBySlug.get(item.slug)
      : item._tempId
        ? displayPages.find((p) => p._tempId === item._tempId)
        : undefined;
    if (!page) continue;

    const selectKey = keyFor(page);
    const sortableId = navSortableId(item, fullIdx);
    const isUntitled = !(page.title ?? "").trim();
    const canDelete =
      isConvenor && (useYjs ? (page._yMap ? ops!.canDelete(page._yMap) : true) : false);

    if (isUntitled) {
      untitledRows.push({
        selectKey,
        sortableId,
        label: page.title?.trim() || t("untitled_needs_title"),
        isUntitled: true,
        canDelete,
      });
    } else {
      sidebarIdToFullIdx.set(sortableId, fullIdx);
      contentRows.push({
        selectKey,
        sortableId,
        label: page.title.trim(),
        isUntitled: false,
        canDelete,
      });
    }
  }

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
    const contributors = computeContributors(
      page._createdBy ?? null,
      currentUserId,
      members as Member[]
    );
    setDeleteTarget({ page, contributors });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const { page } = deleteTarget;
    if (useYjs) {
      ops!.deletePage(page.id > 0 ? page.id : null, page._tempId ?? null);
      if (ydoc && page.slug) {
        const config = ydoc.getMap("config");
        const navArray = config.get("navigation") as unknown;
        if (navArray instanceof Y.Array) {
          ydoc.transact(() => {
            for (let i = 0; i < navArray.length; i++) {
              const item = navArray.get(i) as Record<string, unknown>;
              if (item.type === "page" && item.slug === page.slug) {
                navArray.delete(i, 1);
                break;
              }
            }
          });
        }
      }
    }
    setDeleteTarget(null);
  }

  // Remote-delete toast — fires when a page disappears from the Y.Array
  // because a peer removed it. Shared logic in useRemoteDeleteToast.
  useRemoteDeleteToast({
    items: displayPages,
    enabled: useYjs,
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
    if (useYjs && page._yMap && !ops!.canDelete(page._yMap)) return;
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
  const scanData = repoScanFetcher.data;
  const scannedPages = scanData?.ok && scanData.intent === "scan-repo-pages"
    ? scanData.pages
    : [];
  const showImportVariant = displayPages.length === 0 && scannedPages.length > 0;

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
      </div>

      {/* Repo-import recovery banner (only when no content pages exist yet) */}
      {showImportVariant && (
        <div className="mx-6 mb-2">
          <PagesRepoImportEmptyState
            pages={scannedPages.map((p) => ({ slug: p.slug, title: p.title }))}
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
                      canDelete={page && useYjs && page._yMap ? ops!.canDelete(page._yMap) : false}
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
