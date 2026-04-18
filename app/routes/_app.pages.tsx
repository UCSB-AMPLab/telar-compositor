/**
 * Pages tab — static page editor for the active project.
 *
 * The tab bar is a live preview of the site's navigation menu: site title
 * on the left, right-aligned nav items (Home, Objects, Glossary, user pages,
 * Share). User pages are draggable; all nav items are rearrangeable.
 * A + button on the left creates new pages.
 *
 * Slug generation is deferred — pages start with an empty slug and it
 * auto-generates from the title once the user edits it.
 */

import { asc, eq, and } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher } from "react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import * as Y from "yjs";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Upload } from "lucide-react";
import type { Route } from "./+types/_app.pages";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { project_pages, project_members, users } from "~/db/schema";
import { resolveActiveProject } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { normaliseSlug, makeUniqueSlug } from "~/lib/slug";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { SlugField } from "~/components/ui/SlugField";
import { SortablePageTab } from "~/components/features/pages/SortablePageTab";
import { PagesEmptyState } from "~/components/features/pages/PagesEmptyState";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { useToast } from "~/hooks/use-toast";
import { findYMapByIdOrTempId, getYText } from "~/lib/yjs-helpers";

export const handle = { i18n: ["common", "pages", "editor", "structural"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
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

  return {
    project: activeProject,
    pages,
    members,
    currentUserId: user.id,
    userRole,
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

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
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
  const { t: tStructural } = useTranslation("structural");
  const {
    project,
    pages: loaderPages,
    members,
    currentUserId,
    userRole,
  } = loaderData;

  const { ydoc, remoteCollaborators, isPublishing } = useCollaborationContext();
  const ops = useStructuralOps(currentUserId, userRole);
  const { showToast } = useToast();
  const bodyFetcher = useFetcher();

  // ------------------------------------------------------------------
  // Source of truth: Yjs when available, loader data otherwise
  // ------------------------------------------------------------------
  const [yjsPages, setYjsPages] = useState<PageItem[] | null>(null);

  useEffect(() => {
    if (!ydoc) {
      setYjsPages(null);
      return;
    }
    const pagesArray = ydoc.getArray<Y.Map<unknown>>("pages");

    const recompute = () => {
      const next: PageItem[] = [];
      for (let i = 0; i < pagesArray.length; i++) {
        next.push(yMapToPageItem(pagesArray.get(i), i));
      }
      setYjsPages(next);
    };
    recompute();
    pagesArray.observeDeep(recompute);
    return () => pagesArray.unobserveDeep(recompute);
  }, [ydoc]);

  const useYjs = ydoc !== null && ops !== null && yjsPages !== null;
  const displayPages: PageItem[] = useYjs
    ? yjsPages!
    : (loaderPages as PageItem[]);

  // Stable dnd-kit identifier
  const keyFor = (p: PageItem): string =>
    p.id > 0 ? String(p.id) : p._tempId ?? `idx-${p._yIndex ?? 0}`;

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
        setNavItems(navArray.toArray() as NavItem[]);
      }
    };
    recomputeNav();
    config.observeDeep(recomputeNav);
    return () => config.unobserveDeep(recomputeNav);
  }, [ydoc]);

  // Site title from Yjs config
  const [siteTitle, setSiteTitle] = useState(project.title || "");

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
  // Selected page state
  // ------------------------------------------------------------------
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (displayPages.length > 0 && selectedKey === null) {
      setSelectedKey(keyFor(displayPages[0]));
    }
    if (
      selectedKey !== null &&
      !displayPages.some((p) => keyFor(p) === selectedKey)
    ) {
      setSelectedKey(displayPages.length > 0 ? keyFor(displayPages[0]) : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPages]);

  const selectedPage = selectedKey
    ? displayPages.find((p) => keyFor(p) === selectedKey) ?? null
    : null;

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

  useEffect(() => {
    if (!useYjs || !ydoc) return;
    for (const page of displayPages) {
      const key = keyFor(page);
      const prevTitle = prevTitleForSlugRef.current.get(key);
      if (
        prevTitle !== undefined &&
        prevTitle !== page.title &&
        page.title &&
        !page.slug
      ) {
        const pArr = ydoc.getArray<Y.Map<unknown>>("pages");
        const targetYMap = findYMapByIdOrTempId(
          pArr,
          page.id > 0 ? page.id : null,
          page._tempId ?? null
        );
        if (targetYMap) {
          const allSlugs = new Set<string>();
          for (let i = 0; i < pArr.length; i++) {
            const s = pArr.get(i).get("slug") as string;
            if (s) allSlugs.add(s);
          }
          const { slug: newSlug } = makeUniqueSlug(normaliseSlug(page.title), allSlugs);
          ydoc.transact(() => {
            targetYMap.set("slug", newSlug);
            // Also add to navigation array
            const config = ydoc.getMap("config");
            const navArray = config.get("navigation");
            if (navArray instanceof Y.Array) {
              navArray.push([{ type: "page", slug: newSlug, label: page.title, visible: true }]);
            }
          });
        }
      }
      prevTitleForSlugRef.current.set(key, page.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPages, useYjs]);

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
    ...displayPages
      .filter((p) => p.slug)
      .map((p) => ({ type: "page" as const, slug: p.slug, label: p.title || p.slug, visible: true })),
  ];

  const effectiveNavItems = navItems.length > 0 ? navItems : defaultNavItems;

  // Each nav item gets a stable sortable ID
  const navSortableId = (item: NavItem, idx: number): string => {
    if (item.type === "builtin") return `nav-builtin-${item.key}`;
    if (item.type === "page") return `nav-page-${item.slug || idx}`;
    return `nav-${idx}`;
  };

  // Map page slugs to page keys for selection
  const pageBySlug = new Map(displayPages.map((p) => [p.slug, p]));

  const navSortableIds = effectiveNavItems.map((item, i) => navSortableId(item, i));

  // Builtin labels
  const builtinLabels: Record<string, string> = {
    home: t("nav_home"),
    collection: t("nav_objects"),
    glossary: t("nav_glossary"),
  };

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

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

  // ------------------------------------------------------------------
  // Remote-delete detection
  // ------------------------------------------------------------------
  const prevTitlesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!useYjs) return;
    const curr = new Map<string, string>();
    for (const p of displayPages) curr.set(keyFor(p), p.title || p.slug);
    const deleted: Array<{ key: string; title: string }> = [];
    prevTitlesRef.current.forEach((title, key) => {
      if (!curr.has(key)) deleted.push({ key, title });
    });
    prevTitlesRef.current = curr;
    if (deleted.length === 0) return;
    const deleterName = remoteCollaborators[0]?.user.name ?? "";
    for (const { title } of deleted) {
      const message = deleterName
        ? tStructural("toast_item_deleted", { label: title, name: deleterName })
        : tStructural("toast_item_deleted_generic", { label: title });
      showToast({
        message,
        type: "destructive",
        ...(userRole === "convenor"
          ? { action: { label: tStructural("toast_item_deleted_undo"), onClick: () => {} } }
          : {}),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPages, useYjs, userRole]);

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  function handleNavDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !ydoc) return;

    const oldIndex = navSortableIds.indexOf(String(active.id));
    const newIndex = navSortableIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const config = ydoc.getMap("config");
    const navArray = config.get("navigation");
    if (!(navArray instanceof Y.Array)) return;

    ydoc.transact(() => {
      // Nav items are plain JS objects (not Y.Maps) — shallow-clone so Yjs
      // sees a fresh value on the insert side, avoiding any shared-reference
      // ambiguity between the delete and insert events in the same transact.
      const source = navArray.get(oldIndex);
      const clone = source && typeof source === "object" ? { ...source } : source;
      navArray.delete(oldIndex, 1);
      navArray.insert(newIndex, [clone]);
    });

    // If the moved item was a page, also reorder pages array to match
    const movedNav = effectiveNavItems[oldIndex];
    if (movedNav.type === "page" && movedNav.slug) {
      const pageOldIdx = displayPages.findIndex((p) => p.slug === movedNav.slug);
      // Find the target page index from the nav item at newIndex
      const targetNav = effectiveNavItems[newIndex];
      if (targetNav.type === "page" && targetNav.slug) {
        const pageNewIdx = displayPages.findIndex((p) => p.slug === targetNav.slug);
        if (pageOldIdx >= 0 && pageNewIdx >= 0 && pageOldIdx !== pageNewIdx) {
          ops?.reorderPages(pageOldIdx, pageNewIdx);
        }
      }
    }
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

  if (displayPages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PagesEmptyState onCreateNew={handleCreatePage} />
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${publishLock}`}>
      {/* Instructional copy */}
      <div className="px-6 pt-4 pb-2 space-y-2 max-w-2xl">
        <p className="font-body text-sm text-gray-500">
          {t("nav_bar_intro")}{" "}
          <a href="https://telar.org/docs/site-features/custom-pages/" target="_blank" rel="noopener noreferrer" className="text-terracotta hover:text-terracotta/80 underline">{t("learn_more")}</a>.
        </p>
        <p className="font-body text-sm text-gray-500">{t("nav_bar_instructions")}</p>
      </div>

      {/* Nav bar preview */}
      <div className="mx-6 border border-gray-200 rounded-lg bg-white">
        <div className="flex items-center h-[44px] px-4">
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
            <SortableContext items={navSortableIds} strategy={horizontalListSortingStrategy}>
              {effectiveNavItems.map((item, idx) => {
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
                  const page = pageBySlug.get(item.slug ?? "");
                  const key = page ? keyFor(page) : sid;
                  return (
                    <SortablePageTab
                      key={sid}
                      sortableId={sid}
                      label={item.label || page?.title || t("untitled")}
                      isSelected={page ? key === selectedKey : false}
                      onSelect={() => { if (page) setSelectedKey(keyFor(page)); }}
                      onDelete={page ? () => handleDeleteClick(page) : undefined}
                      canDelete={page && useYjs && page._yMap ? ops!.canDelete(page._yMap) : false}
                    />
                  );
                }
                return null;
              })}
            </SortableContext>
          </DndContext>

          {/* Add new page — pill button, before Share */}
          <button
            type="button"
            onClick={handleCreatePage}
            disabled={!useYjs}
            className="ml-2 px-4 h-[28px] flex items-center gap-1 rounded-full bg-periwinkle hover:bg-periwinkle/80 text-charcoal font-heading font-semibold text-xs uppercase tracking-wider disabled:opacity-40 transition-colors shrink-0"
            aria-label={t("new_page_button")}
          >
            {t("new_page_button")}
          </button>

          {/* Share placeholder — matches Telar navbar share button */}
          <div className="ml-2 px-3 h-[28px] flex items-center gap-1.5 rounded-full border border-gray-200 text-gray-300">
            <Upload className="w-3.5 h-3.5" />
            <span className="font-body text-xs">{t("nav_share")}</span>
          </div>
        </div>
      </div>

      {/* Editor panel — matches LayerPanel structure: label → input, label → editor.
           Uses h- (not min-h-) so flex children get a definite height to fill.
           260px ≈ header(56) + tabNav(44) + main padding(48) + instructions(36) + navBar(60) + gap(16). */}
      <div className="flex flex-col h-[calc(100dvh-260px)] mx-6 mt-4 mb-6 bg-white rounded-lg shadow-sm overflow-hidden">
        {!selectedPage ? (
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
                className="w-full px-4 py-2 font-heading font-semibold text-lg border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-periwinkle/30"
                fieldKey={`page-${selectedKey}-title`}
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
              <div className="flex-1 min-h-0 overflow-y-auto">
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
