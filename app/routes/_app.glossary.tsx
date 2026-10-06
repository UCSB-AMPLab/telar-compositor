/**
 * This file is the Glossary route — the find / trace / rename / preview
 * term editor for the active project's glossary.
 *
 * Left sidebar: a `?q=` filter input above "New term", then the
 * alphabetically sorted term list. Right editor: the term title, an
 * editable rename-aware `term_id`, a "Used in" trace section, the definition
 * (a Markdown editor with `[[term]]` chips), and a live themed reader-preview
 * pane.
 *
 * The route stays a thin shell over a set of pure helper libs that carry
 * the real logic: the `?q=` substring filter, the on-demand "Used in"
 * reference index, the slug-lock state machine and uniqueness guard that
 * govern how a `term_id` is derived from (or detached from) the title,
 * and the rename impact panel that counts and rewrites `[[term]]` links
 * across all definitions in a single transaction.
 *
 * The canvas is cream / charcoal — identity is carried by the chrome and
 * the anil-ink chips rather than a coloured panel. All data reads from
 * the Yjs "glossary" Y.Array; structural mutations go through
 * useStructuralOps. Convenor-only affordances (new / rename / delete /
 * quick-create) are role-gated in the UI; the server-side gates remain
 * the real boundary.
 *
 * @version v1.5.1-beta
 */

import { eq } from "drizzle-orm";
import { redirect, useSearchParams, useOutletContext } from "react-router";
import { useState, useEffect, useMemo, useCallback } from "react";
import * as Y from "yjs";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Route } from "./+types/_app.glossary";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { project_members, project_config } from "~/db/schema";
import { resolveActiveProjectFromRequest, resolvePageProject, siteChangedAnswer } from "~/lib/active-project.server";
import { slugifyTermId } from "~/lib/slug";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { GlossaryEmptyState } from "~/components/features/glossary/GlossaryEmptyState";
import { GlossaryAddressNotice, sharedAddressOf } from "~/components/features/glossary/GlossaryAddressNotice";
import { sharedGlossaryAddresses } from "~/lib/glossary-addresses";
import { readTermKind, readTermText, termKey, type TermItem } from "~/lib/glossary-terms";
import { kindLabelOf } from "~/lib/glossary-kinds";
import { readGlossaryKinds } from "~/lib/glossary-kinds.server";
import { saveGlossaryKinds } from "~/lib/glossary-kinds-save.server";
import { GlossaryKindSelect, KindCaption, useGlossaryKinds } from "~/components/features/glossary/GlossaryKindSelect";
import { EditKindsButton, GlossaryKindsDialog } from "~/components/features/glossary/GlossaryKindsDialog";
import { UsedInPanel } from "~/components/features/glossary/UsedInPanel";
import { RenameImpactPanel } from "~/components/features/glossary/RenameImpactPanel";
import { GlossaryPreviewPane } from "~/components/features/glossary/GlossaryPreviewPane";
import { DocsLink } from "~/components/ui/DocsLink";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { useIsConvenor } from "~/hooks/use-role";
import { useToast } from "~/hooks/use-toast";
import { getYText } from "~/lib/yjs-helpers";
import { listsTerm, matchesTermFilter } from "~/lib/glossary-filter";
import {
  isSlugLocked,
  effectiveSlug,
  makeUniqueTermId,
} from "~/lib/glossary-slug";
import {
  buildTermRefIndex,
  countGlossaryLinks,
  rewriteGlossaryLinks,
  type TermRef,
} from "~/lib/glossary-refs";

export const handle = { i18n: ["glossary", "common", "structural"] };

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

  const memberRows = await db
    .select({
      userId: project_members.user_id,
    })
    .from(project_members)
    .where(eq(project_members.project_id, activeProject.id));

  // Published theme for the reader-preview pane. Mirrors the objects
  // loader's project_config read; null when no config row / theme set, in which
  // case the preview falls back to the neutral cream/charcoal token set.
  const [config] = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);

  return {
    project: activeProject,
    currentUserId: user.id,
    userRole,
    memberIds: memberRows.map((m) => m.userId),
    theme: config?.theme ?? null,
    // The site's own kinds as stored, null while the config is their source.
    // A save of the kinds names this text as the list it replaces.
    storedGlossaryKinds: config?.glossary_kinds_json ?? null,
    // Not awaited: the page renders while the site's files are read, and the
    // kind choice appears when they arrive.
    glossaryKinds: readGlossaryKinds(env, user.encrypted_access_token, activeProject, config?.glossary_kinds_json ?? null),
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/** A form field holding JSON, parsed; undefined when absent or not JSON. */
function jsonField(formData: FormData, name: string): unknown {
  const value = formData.get(name);
  try {
    return typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `save-kinds` stores the site's own glossary kinds (`glossary-kinds-save.server.ts`):
 * `kinds` is the list as JSON, `base` the stored text the page read, absent
 * when it read null, and then `seenRepo` the `repoSite` of the kinds it showed.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });
  const env = context.cloudflare.env as Env;
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent !== "save-kinds") throw new Response("Bad request", { status: 400 });

  const resolved = await resolvePageProject(request, env, user.id, formData);
  if (resolved.kind === "site_changed") return siteChangedAnswer(intent, resolved.currentSiteName);
  if (resolved.kind === "no_project") throw redirect("/dashboard");
  const { project, userRole } = resolved;
  const base = formData.get("base");
  const seenRepo = formData.get("seenRepo");
  const result = await saveGlossaryKinds(getDb(env.DB), {
    projectId: project.id,
    role: userRole,
    base: typeof base === "string" ? base : null,
    seenRepo: typeof seenRepo === "string" ? seenRepo : null,
    headSha: project.head_sha,
    kinds: jsonField(formData, "kinds"),
    readRepoKinds: () => readGlossaryKinds(env, user.encrypted_access_token, project),
  });
  return { intent, ...result };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GlossaryPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("glossary");
  const { project, currentUserId, userRole, theme } = loaderData;

  const kinds = useGlossaryKinds(loaderData.glossaryKinds);

  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};

  const { ydoc, isPublishing } = useCollaborationContext();
  const ops = useStructuralOps(currentUserId, userRole);
  const isConvenor = useIsConvenor();
  const { showToast } = useToast();

  // Selected term key (id: or tmp: prefix)
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [kindsOpen, setKindsOpen] = useState(false);

  // Delete modal state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TermItem | null>(null);

  // Filter query — URL state under ?q=
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";

  const setQuery = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next.trim() === "") params.delete("q");
          else params.set("q", next);
          return params;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  // Rename impact panel state — open only when refs>0 AND the slug changes
  const [renameImpact, setRenameImpact] = useState<{
    oldId: string;
    newId: string;
    count: number;
  } | null>(null);

  // ------------------------------------------------------------------
  // Live Yjs observation — rebuild sorted term list on any change
  // ------------------------------------------------------------------
  const [termVersion, setTermVersion] = useState(0);

  useEffect(() => {
    if (!ydoc) return;
    const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
    const bump = () => setTermVersion((v) => v + 1);
    glossaryArray.observeDeep(bump);
    // Initial read
    bump();
    return () => glossaryArray.unobserveDeep(bump);
  }, [ydoc]);

  // The shared addresses, read in the document's order (the array's), which is
  // the order the site keeps the first id in.
  const sharedAddresses = useMemo(() => {
    if (!ydoc) return [];
    const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
    const rows = glossaryArray.toArray().map((m) => ({
      term_id: (m.get("term_id") as string | undefined) ?? null,
      title: readTermText(m, "title"),
    }));
    return sharedGlossaryAddresses(rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, termVersion]);

  const sortedTerms = useMemo<TermItem[]>(() => {
    if (!ydoc) return [];
    const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
    const items: TermItem[] = [];
    for (let i = 0; i < glossaryArray.length; i++) {
      const m = glossaryArray.get(i);
      if (!listsTerm(m.get("term_id"))) continue;
      const title = readTermText(m, "title");
      const term_id = (m.get("term_id") as string | undefined) ?? slugifyTermId(title);
      items.push({
        _id: (m.get("_id") as number | null) ?? null,
        _temp_id: (m.get("_temp_id") as string | null) ?? null,
        title,
        term_id,
        definition: readTermText(m, "definition"),
        kind: readTermKind(m),
        yMap: m,
      });
    }
    return items.sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, termVersion]);

  // ?q= substring filter on title OR definition
  const filteredTerms = useMemo<TermItem[]>(() => {
    return sortedTerms.filter((term) =>
      matchesTermFilter({ title: term.title, definition: term.definition }, query),
    );
  }, [sortedTerms, query]);

  // ------------------------------------------------------------------
  // Selected term — resolved from the sorted list by key
  // ------------------------------------------------------------------
  const selectedTerm = useMemo<TermItem | null>(() => {
    if (!selectedKey) return null;
    return sortedTerms.find((t) => termKey(t) === selectedKey) ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedTerms, selectedKey]);

  // Auto-select first term on initial load if nothing selected
  useEffect(() => {
    if (selectedKey === null && sortedTerms.length > 0) {
      setSelectedKey(termKey(sortedTerms[0]));
    }
  }, [sortedTerms, selectedKey]);

  // ------------------------------------------------------------------
  // "Used in" — computed on-demand for the selected term.
  // No persistent index, no per-keystroke recompute: it rebuilds only when the
  // selection or the doc version changes (the term panel is open).
  // ------------------------------------------------------------------
  const usedInRefs = useMemo<TermRef[]>(() => {
    if (!ydoc || !selectedTerm) return [];
    const index = buildTermRefIndex(ydoc);
    return index.get(selectedTerm.term_id) ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, selectedTerm, termVersion]);

  // Existing term_ids (for the uniqueness guard on rename)
  const existingTermIds = useMemo<string[]>(
    () => sortedTerms.map((term) => term.term_id),
    [sortedTerms],
  );

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  // In-route select by term_id — resolved chip click + cross-ref jump.
  const selectTermById = useCallback(
    (termId: string) => {
      const target = sortedTerms.find((term) => term.term_id === termId);
      if (target) setSelectedKey(termKey(target));
    },
    [sortedTerms],
  );

  const handleAddTerm = useCallback(() => {
    if (!ops || !ydoc) return;
    // Add a new term — we'll auto-select it after it appears in sortedTerms
    const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
    const prevLength = glossaryArray.length;
    ops.addGlossaryTerm(t("untitled_term"));

    // The new item lands at the end of the Y.Array; we select it by _temp_id
    // which we can read after the transact via the array's last item.
    requestAnimationFrame(() => {
      const arr = ydoc.getArray<Y.Map<unknown>>("glossary");
      if (arr.length > prevLength) {
        const newMap = arr.get(arr.length - 1);
        const newTempId = newMap.get("_temp_id") as string | null;
        if (newTempId) setSelectedKey(`tmp:${newTempId}`);
      }
    });
  }, [ops, ydoc, t]);

  // Unresolved `[[foo]]` chip CTA → inline quick-create. One Yjs
  // transaction (empty title + empty definition); the author stays put. An info
  // toast offers "Edit term →" which selects the freshly-created term in-route.
  const handleQuickCreate = useCallback(
    (termId: string) => {
      if (!ops || !ydoc || !isConvenor) return;
      const uniqueId = makeUniqueTermId(termId, existingTermIds);
      ops.addGlossaryTermWithId(uniqueId, "");
      showToast({
        type: "info",
        message: t("quick_create_toast", { term: uniqueId }),
        action: {
          label: t("quick_create_edit"),
          onClick: () => selectTermById(uniqueId),
        },
      });
    },
    [ops, ydoc, isConvenor, existingTermIds, showToast, t, selectTermById],
  );

  const handleRequestDelete = useCallback((term: TermItem) => {
    setPendingDelete(term);
    setDeleteOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!ops || !pendingDelete) return;
    const { _id, _temp_id } = pendingDelete;
    ops.deleteGlossaryTerm(_id, _temp_id);
    // Clear selection if we deleted the selected term
    const deletedKey = termKey(pendingDelete);
    setSelectedKey((prev) => (prev === deletedKey ? null : prev));
    setPendingDelete(null);
    setDeleteOpen(false);
  }, [ops, pendingDelete]);

  const handleCloseDelete = useCallback(() => {
    setPendingDelete(null);
    setDeleteOpen(false);
  }, []);

  // ------------------------------------------------------------------
  // Slug write-back: title→term_id auto-derive GATED on the slug lock.
  // When the term_id still tracks the title (unlocked), a title change
  // re-derives the slug. When it would change AND existing links point to the
  // old slug, open the rename impact panel; otherwise apply the slug silently.
  // When the user has hand-edited term_id (locked), the title no longer
  // clobbers it.
  // ------------------------------------------------------------------
  const applySlug = useCallback(
    (yMap: Y.Map<unknown>, newSlug: string) => {
      if (!ydoc) return;
      ydoc.transact(() => {
        yMap.set("term_id", newSlug);
      });
    },
    [ydoc],
  );

  // Evaluate a candidate slug change for the selected term: fire the impact
  // panel when refs>0 and the slug differs; else apply silently.
  const evaluateSlugChange = useCallback(
    (yMap: Y.Map<unknown>, oldId: string, candidate: string) => {
      if (!ydoc || !isConvenor) return;
      const unique = makeUniqueTermId(
        candidate,
        existingTermIds.filter((id) => id !== oldId),
      );
      if (unique === oldId) return; // no effective change
      const count = countGlossaryLinks(ydoc, oldId);
      if (count > 0) {
        setRenameImpact({ oldId, newId: unique, count });
      } else {
        applySlug(yMap, unique);
      }
    },
    [ydoc, isConvenor, existingTermIds, applySlug],
  );

  // Title→slug auto-derive, gated on the lock.
  //
  // The Y.Text observer fires on every keystroke; evaluating the rename impact
  // per-keystroke pops/churns the impact panel against a moving `newId` while
  // the author is still typing. Debounce the evaluation so it runs on a
  // settled slug — once typing pauses — rather than on every observed change.
  // The actual slug derive + rewrite behaviour is unchanged.
  useEffect(() => {
    if (!selectedTerm || !ydoc || !isConvenor) return;
    const titleYText = selectedTerm.yMap.get("title");
    if (!(titleYText instanceof Y.Text)) return;
    const yMap = selectedTerm.yMap;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const evaluate = () => {
      const currentTermId = (yMap.get("term_id") as string | undefined) ?? "";
      const title = titleYText.toString();
      // Skip the clobber when the slug is locked (hand-edited away from title).
      if (isSlugLocked(currentTermId, title)) return;
      const candidate = effectiveSlug(currentTermId, title, false);
      evaluateSlugChange(yMap, currentTermId, candidate);
    };

    const onTitleChange = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(evaluate, 500);
    };

    titleYText.observe(onTitleChange);
    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      titleYText.unobserve(onTitleChange);
    };
  }, [selectedTerm, ydoc, isConvenor, evaluateSlugChange]);

  // Direct term_id edit (locks the slug). Evaluates the rename impact too.
  const handleTermIdInput = useCallback(
    (raw: string) => {
      if (!selectedTerm) return;
      const oldId = selectedTerm.term_id;
      evaluateSlugChange(selectedTerm.yMap, oldId, raw);
    },
    [selectedTerm, evaluateSlugChange],
  );

  // Rename impact panel actions.
  const handleRenameUpdate = useCallback(() => {
    if (!ydoc || !selectedTerm || !renameImpact) return;
    applySlug(selectedTerm.yMap, renameImpact.newId);
    const n = rewriteGlossaryLinks(ydoc, renameImpact.oldId, renameImpact.newId);
    showToast({ type: "info", message: t("rename_done", { count: n }) });
    setRenameImpact(null);
  }, [ydoc, selectedTerm, renameImpact, applySlug, showToast, t]);

  const handleRenameKeep = useCallback(() => {
    if (!selectedTerm || !renameImpact) return;
    // Apply the slug to THIS term only; leave existing [[old]] links untouched.
    applySlug(selectedTerm.yMap, renameImpact.newId);
    setRenameImpact(null);
  }, [selectedTerm, renameImpact, applySlug]);

  // Clear a stale impact panel when the selection changes.
  useEffect(() => {
    setRenameImpact(null);
  }, [selectedKey]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  // Empty state — show when Yjs is ready and no term is listed. Held terms
  // (`listsTerm`) are in the array but never shown, so they do not count.
  if (ydoc && sortedTerms.length === 0) {
    return (
      <div className={`h-[calc(100dvh-160px)] flex items-center justify-center ${isPublishing ? "opacity-50 pointer-events-none" : ""}`}>
        <GlossaryEmptyState onCreateNew={handleAddTerm} />
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${isPublishing ? "opacity-50 cursor-not-allowed" : ""}`}>
      {/* Instructional copy */}
      <div className="px-6 pt-4 pb-2 space-y-2 max-w-2xl">
        <p className="font-body text-sm text-fg-muted">
          {t("intro")}{" "}
          <a href="https://telar.org/docs/site-features/glossary/" target="_blank" rel="noopener noreferrer" className="text-terracotta hover:text-terracotta/80 underline">{t("learn_more")}</a>.
        </p>
        <p className="font-body text-sm text-fg-muted">{t("intro_instructions")}</p>
        {openDoc && <DocsLink docId="glossary" onOpenDoc={openDoc} />}
      </div>

    <div className="flex h-[calc(100dvh-220px)]">
      {/* Sidebar */}
      <aside className="w-44 sm:w-60 border-r border-gray-200 flex flex-col h-full bg-cream shrink-0">
        {/* Filter input — ?q= state */}
        <div className="p-3 border-b border-gray-200 space-y-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("filter", { count: sortedTerms.length })}
            aria-label={t("filter", { count: sortedTerms.length })}
            className="w-full font-body text-sm text-charcoal bg-surface border border-gray-200 rounded-md px-3 py-1.5"
          />
          {/* New Term button (convenor-only — don't render for collaborators) */}
          {isConvenor && (
            <button
              type="button"
              onClick={handleAddTerm}
              disabled={isPublishing || !ops}
              className="inline-flex items-center gap-1.5 bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("new_term_button")}
            </button>
          )}
        </div>

        {/* Term list */}
        <ul className="flex-1 overflow-y-auto" role="list">
          {filteredTerms.map((term) => {
            const key = termKey(term);
            const isSelected = key === selectedKey;
            return (
              <li key={key}>
                <div className="flex items-center group">
                  <button
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    className={`flex-1 text-left px-4 py-3 font-body text-sm text-charcoal transition-colors truncate ${
                      isSelected
                        ? "bg-cream-dark font-semibold"
                        : "hover:bg-cream-dark"
                    }`}
                  >
                    {term.title || t("untitled_term")}
                    <KindCaption kinds={kinds} value={term.kind} />
                    {sharedAddressOf(sharedAddresses, term.term_id.trim()) && (
                      <AlertTriangle
                        className="inline-block w-3.5 h-3.5 ml-1.5 align-text-bottom text-amber-600"
                        role="img"
                        aria-label={t("address_shared_marker")}
                      />
                    )}
                  </button>
                  {/* Trash icon — convenor-only, visible on hover */}
                  {isConvenor && (
                    <button
                      type="button"
                      aria-label={t("delete_term")}
                      onClick={() => handleRequestDelete(term)}
                      disabled={isPublishing || !ops}
                      className="pr-3 pl-1 py-3 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Detail editor — cream surface, charcoal ink */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-cream rounded-lg">
        {!selectedTerm ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="font-body text-sm text-fg-muted">{t("no_term_selected")}</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex">
            {/* Left half: title, term_id, used-in, definition */}
            <div className="flex-1 basis-0 min-w-0 min-h-0 flex flex-col overflow-hidden">
              {/* TERM TITLE section */}
              <div className="px-6 pt-6 pb-4 shrink-0">
                <label className="block font-heading text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2">
                  {t("title_label")}
                </label>
                <InlineTextField
                  initialValue={selectedTerm.title}
                  yText={getYText(selectedTerm.yMap, "title")}
                  fieldKey={`glossary-title-${selectedKey}`}
                  placeholder={t("untitled_term")}
                  inputClassName="font-heading text-xl font-semibold text-charcoal rounded-md border border-gray-200 px-3 py-2 bg-surface hover:border-gray-300 focus:border-anil-deep"
                />

                <GlossaryKindSelect
                  kinds={kinds}
                  value={selectedTerm.kind}
                  onChange={(id) => selectedTerm.yMap.set("kind", id)}
                  labelAction={<EditKindsButton kinds={kinds} onClick={() => setKindsOpen(true)} />}
                />

                {/* TERM ID — editable, rename-aware */}
                <div className="mt-4">
                  <label
                    htmlFor="glossary-term-id"
                    className="block font-heading text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2"
                  >
                    {t("term_id_section_label")}
                  </label>
                  {isConvenor ? (
                    <input
                      id="glossary-term-id"
                      type="text"
                      defaultValue={selectedTerm.term_id}
                      key={`term-id-${selectedKey}-${selectedTerm.term_id}`}
                      onBlur={(e) => handleTermIdInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      className="font-mono text-xs text-charcoal bg-surface rounded-md border border-gray-200 px-2.5 py-1.5 w-full max-w-xs"
                    />
                  ) : (
                    <p className="font-body text-xs text-fg-muted">
                      <span className="font-mono text-charcoal">{selectedTerm.term_id || "—"}</span>
                    </p>
                  )}

                  <GlossaryAddressNotice
                    shared={sharedAddressOf(sharedAddresses, selectedTerm.term_id.trim())}
                    termId={selectedTerm.term_id.trim()}
                    className="mt-2 max-w-md"
                  />

                  {/* Rename impact panel — refs>0 AND slug changes */}
                  {renameImpact && (
                    <RenameImpactPanel
                      count={renameImpact.count}
                      oldId={renameImpact.oldId}
                      newId={renameImpact.newId}
                      onUpdate={handleRenameUpdate}
                      onKeep={handleRenameKeep}
                    />
                  )}
                </div>


                {/* USED IN — on-demand trace */}
                <UsedInPanel
                  refs={usedInRefs}
                  onSelectTerm={selectTermById}
                  className="mt-4"
                />
              </div>

              {/* DEFINITION section — fills remaining height */}
              <div className="flex-1 min-h-0 flex flex-col px-6 pb-4">
                <label className="block font-heading text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2 shrink-0">
                  {t("definition_label")}
                </label>
                <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-gray-200 bg-surface">
                  <MarkdownEditor
                    initialValue={selectedTerm.definition}
                    fieldName="definition"
                    projectId={project.id}
                    yText={getYText(selectedTerm.yMap, "definition")}
                    transparent
                    alwaysShowToolbar
                    enableGlossaryLinks
                    onChipClick={selectTermById}
                    onUnresolvedChipClick={isConvenor ? handleQuickCreate : undefined}
                    className="h-full flex flex-col"
                  />
                </div>
              </div>
            </div>

            {/* Right half: live reader preview, the same width as the editor so
                a definition with headings, lists or images reads as it will on
                the site. Hidden below lg, where there is no room for a third
                pane beside the term rail and editor; the editor fills the width. */}
            <div className="hidden lg:flex flex-1 basis-0 min-w-0 min-h-0">
              <GlossaryPreviewPane
                yMap={selectedTerm.yMap}
                theme={theme}
                termVersion={termVersion}
                titleLabel={selectedTerm.title}
                kindLabel={kindLabelOf(kinds, selectedTerm.kind)}
                className="m-6 ml-0 flex-1 min-w-0 min-h-0"
              />
            </div>
          </div>
        )}
      </main>

      <GlossaryKindsDialog
        open={kindsOpen}
        onClose={() => setKindsOpen(false)}
        kinds={kinds}
        stored={loaderData.storedGlossaryKinds}
        ydoc={ydoc}
      />

      {/* Delete confirmation modal */}
      <DeleteConfirmationModal
        open={deleteOpen}
        onClose={handleCloseDelete}
        onConfirm={handleConfirmDelete}
        entityType="glossary_term"
        entityLabel={pendingDelete?.title || t("untitled_term")}
        contentSummary={t("delete_term_confirm")}
      />
    </div>
    </div>
  );
}
