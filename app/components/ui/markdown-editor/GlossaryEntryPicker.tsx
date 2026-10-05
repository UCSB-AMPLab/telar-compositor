/**
 * GlossaryEntryPicker — the search field and list of the project's glossary
 * entries that a glossary link and a glossary callout are chosen from. The
 * entries are read from the Yjs glossary array as the picker mounts, sorted
 * by title, and the search matches a title or an id without case.
 *
 * @version v1.5.0-beta
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";

import { useCollaborationContext } from "~/hooks/use-collaboration";

interface GlossaryTerm {
  term_id: string;
  title: string;
}

function glossaryTermFrom(item: Record<string, unknown> | Y.Map<unknown>): GlossaryTerm {
  const glossaryFieldText = (value: unknown) => (value instanceof Y.Text ? value.toString() : String(value ?? ""));
  if (item instanceof Y.Map) return { term_id: glossaryFieldText(item.get("term_id")), title: glossaryFieldText(item.get("title")) };
  return { term_id: glossaryFieldText(item["term_id"]), title: glossaryFieldText(item["title"]) };
}

/** The project's glossary entries with an id, by title. */
function useGlossaryEntries(): GlossaryTerm[] {
  const { ydoc } = useCollaborationContext();
  return useMemo(() => {
    if (!ydoc) return [];
    const rawItems = ydoc.getArray("glossary").toArray() as Array<Record<string, unknown> | Y.Map<unknown>>;
    return rawItems
      .map(glossaryTermFrom)
      .filter((t) => t.term_id)
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [ydoc]);
}

export function GlossaryEntryPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (termId: string) => void;
}) {
  const { t } = useTranslation("glossary");
  const allTerms = useGlossaryEntries();
  const [search, setSearch] = useState("");

  const filteredTerms = useMemo(() => {
    if (!search.trim()) return allTerms;
    const q = search.toLowerCase();
    return allTerms.filter((t) => t.title.toLowerCase().includes(q) || t.term_id.toLowerCase().includes(q));
  }, [allTerms, search]);

  return (
    <>
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("search_terms_placeholder")}
        className="border border-gray-200 rounded-md px-3 py-1.5 text-sm w-full mb-2 font-body text-charcoal"
        autoFocus
      />

      <div className="max-h-[300px] overflow-y-auto border border-gray-100 rounded-md mb-3">
        {filteredTerms.length === 0 ? (
          <p className="font-body text-sm text-gray-400 text-center py-6">
            {search ? t("link_button.no_match") : t("link_button.no_terms")}
          </p>
        ) : (
          filteredTerms.map((term) => (
            <button
              key={term.term_id}
              type="button"
              onClick={() => onSelect(term.term_id)}
              className={`w-full text-left px-3 py-2 border-b border-gray-50 last:border-0 transition-colors ${
                selected === term.term_id ? "bg-anil/20" : "hover:bg-cream-dark/50"
              }`}
            >
              <div className="font-body text-sm text-charcoal">{term.title || t("common:untitled")}</div>
              <div className="font-body text-xs text-gray-400">{term.term_id}</div>
            </button>
          ))
        )}
      </div>
    </>
  );
}
