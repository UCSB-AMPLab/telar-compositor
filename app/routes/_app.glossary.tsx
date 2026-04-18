/**
 * Glossary — two-column term editor for the active project.
 *
 * Left sidebar: alphabetically sorted term list + "New Term" button.
 * Right editor: InlineTextField for title, read-only term_id, MarkdownEditor
 * for the definition.
 *
 * All data reads from the Yjs "glossary" Y.Array. Structural mutations use
 * useStructuralOps. Title edits also update the term_id on the Y.Map via
 * slugifyTermId.
 */

import { eq } from "drizzle-orm";
import { redirect } from "react-router";
import { useState, useEffect, useMemo, useCallback } from "react";
import * as Y from "yjs";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Route } from "./+types/_app.glossary";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { project_members } from "~/db/schema";
import { resolveActiveProject } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { slugifyTermId } from "~/lib/slug";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { GlossaryEmptyState } from "~/components/features/glossary/GlossaryEmptyState";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { getYText } from "~/lib/yjs-helpers";

export const handle = { i18n: ["glossary", "common", "structural"] };

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

  const memberRows = await db
    .select({
      userId: project_members.user_id,
    })
    .from(project_members)
    .where(eq(project_members.project_id, activeProject.id));

  return {
    project: activeProject,
    currentUserId: user.id,
    userRole,
    memberIds: memberRows.map((m) => m.userId),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TermItem {
  _id: number | null;
  _temp_id: string | null;
  title: string;
  term_id: string;
  yMap: Y.Map<unknown>;
}

/** Stable key for React and selection tracking. */
function termKey(t: TermItem): string {
  return t._id !== null ? `id:${t._id}` : `tmp:${t._temp_id ?? ""}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GlossaryPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("glossary");
  const { project, currentUserId, userRole } = loaderData;

  const { ydoc, isPublishing } = useCollaborationContext();
  const ops = useStructuralOps(currentUserId, userRole);

  // Selected term key (id: or tmp: prefix)
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Delete modal state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TermItem | null>(null);

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

  const sortedTerms = useMemo<TermItem[]>(() => {
    if (!ydoc) return [];
    const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
    const items: TermItem[] = [];
    for (let i = 0; i < glossaryArray.length; i++) {
      const m = glossaryArray.get(i);
      const rawTitle = m.get("title");
      const title = rawTitle instanceof Y.Text
        ? rawTitle.toString()
        : typeof rawTitle === "string" ? rawTitle : "";
      const term_id = (m.get("term_id") as string | undefined) ?? slugifyTermId(title);
      items.push({
        _id: (m.get("_id") as number | null) ?? null,
        _temp_id: (m.get("_temp_id") as string | null) ?? null,
        title,
        term_id,
        yMap: m,
      });
    }
    return items.sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, termVersion]);

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
  // Handlers
  // ------------------------------------------------------------------
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

  // Write term_id scalar back to Y.Map when title changes
  useEffect(() => {
    if (!selectedTerm || !ydoc) return;
    const titleYText = selectedTerm.yMap.get("title");
    if (!(titleYText instanceof Y.Text)) return;

    const updateTermId = () => {
      const newTitle = titleYText.toString();
      const newTermId = slugifyTermId(newTitle);
      const currentTermId = selectedTerm.yMap.get("term_id") as string | undefined;
      if (newTermId !== currentTermId) {
        ydoc.transact(() => {
          selectedTerm.yMap.set("term_id", newTermId);
        });
      }
    };

    titleYText.observe(updateTermId);
    return () => titleYText.unobserve(updateTermId);
  }, [selectedTerm, ydoc]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  // Before Yjs connects, ydoc is null — show a minimal layout
  const glossaryArray = ydoc?.getArray<Y.Map<unknown>>("glossary");
  const termCount = glossaryArray?.length ?? 0;

  // Empty state — show when Yjs is ready and there are no terms
  if (ydoc && termCount === 0) {
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
        <p className="font-body text-sm text-gray-500">
          {t("intro")}{" "}
          <a href="https://telar.org/docs/site-features/glossary/" target="_blank" rel="noopener noreferrer" className="text-terracotta hover:text-terracotta/80 underline">{t("learn_more")}</a>.
        </p>
        <p className="font-body text-sm text-gray-500">{t("intro_instructions")}</p>
      </div>

    <div className="flex h-[calc(100dvh-220px)]">
      {/* Sidebar */}
      <aside className="w-60 border-r border-gray-200 flex flex-col h-full bg-cream shrink-0">
        {/* New Term button */}
        <div className="p-3 border-b border-gray-200">
          <button
            type="button"
            onClick={handleAddTerm}
            disabled={isPublishing || !ops}
            className="inline-flex items-center gap-1.5 bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            {t("new_term_button")}
          </button>
        </div>

        {/* Term list */}
        <ul className="flex-1 overflow-y-auto" role="list">
          {sortedTerms.map((term) => {
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
                  </button>
                  {/* Trash icon — inline with term row, visible on hover */}
                  <button
                    type="button"
                    aria-label={t("delete_term")}
                    onClick={() => handleRequestDelete(term)}
                    disabled={isPublishing || !ops}
                    className="pr-3 pl-1 py-3 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Detail editor */}
      <main className="flex-1 flex flex-col overflow-hidden bg-[#537569] rounded-lg">
        {!selectedTerm ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="font-body text-sm text-cream/50">{t("no_term_selected")}</p>
          </div>
        ) : (
          <>
            {/* TERM TITLE section */}
            <div className="px-6 pt-6 pb-4 shrink-0">
              <label className="block font-heading text-xs font-semibold text-cream/70 uppercase tracking-wider mb-2">
                {t("title_label")}
              </label>
              <InlineTextField
                initialValue={selectedTerm.title}
                yText={getYText(selectedTerm.yMap, "title")}
                fieldKey={`glossary-title-${selectedKey}`}
                placeholder={t("untitled_term")}
                inputClassName="font-heading text-xl font-semibold text-cream rounded-md border border-cream/20 px-3 py-2 bg-transparent hover:border-cream/30 focus:border-cream/50 focus:ring-1 focus:ring-cream/30"
              />

              {/* TERM ID — read-only */}
              <div className="mt-4">
                <label className="block font-heading text-xs font-semibold text-cream/70 uppercase tracking-wider mb-2">
                  {t("term_id_section_label")}
                </label>
                <p className="font-body text-xs text-cream/60">
                  <span className="font-medium text-cream/50 mr-1">{t("term_id_label")}:</span>
                  <span className="font-mono text-cream/80">{selectedTerm.term_id || "—"}</span>
                </p>
              </div>
            </div>

            {/* DEFINITION section — fills remaining height */}
            <div className="flex-1 min-h-0 flex flex-col px-6 pb-4">
              <label className="block font-heading text-xs font-semibold text-cream/70 uppercase tracking-wider mb-2 shrink-0">
                {t("definition_label")}
              </label>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <MarkdownEditor
                  initialValue={
                    (() => {
                      const raw = selectedTerm.yMap.get("definition");
                      return raw instanceof Y.Text ? raw.toString() : typeof raw === "string" ? raw : "";
                    })()
                  }
                  fieldName="definition"
                  projectId={project.id}
                  yText={getYText(selectedTerm.yMap, "definition")}
                  transparent
                  alwaysShowToolbar
                  darkTheme
                  enableGlossaryLinks
                  className="h-full flex flex-col"
                />
              </div>
            </div>
          </>
        )}
      </main>

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
