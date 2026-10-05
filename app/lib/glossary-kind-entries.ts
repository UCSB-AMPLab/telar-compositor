/**
 * The glossary entries of each of the site's own kinds, and the rewrite of
 * their stored kind when a kind's id changes. An entry is of a site kind when
 * the site reads its stored value as that kind (`kindOfValue`). A kind the
 * site leaves out reads as nothing, so for it a value naming its id or one of
 * its values counts too: those entries become its own once it is fixed.
 *
 * @version v1.5.0-beta
 */
import type * as Y from "yjs";
import { foldKindValue, kindOfValue, type GlossaryKinds } from "~/lib/glossary-kinds";
import { readTermKind } from "~/lib/glossary-terms";

/** The id of the site kind a stored value names, or undefined for a core kind or none. */
export function siteKindOfValue(kinds: GlossaryKinds, value: string): string | undefined {
  const known = kindOfValue(kinds, value);
  if (known) return kinds.core.some((c) => c.id === known.id) ? undefined : known.id;
  const folded = foldKindValue(value);
  if (!folded) return undefined;
  return kinds.site.find((k) => [k.id, ...k.values].some((v) => foldKindValue(v) === folded))?.id;
}

/** How many of the stored kinds name each site kind, by its id. */
export function countEntriesByKind(kinds: GlossaryKinds, values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const id = siteKindOfValue(kinds, value);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** The stored kind of every entry in the document's glossary. */
export function glossaryEntryKinds(ydoc: Y.Doc | null): string[] {
  return ydoc ? ydoc.getArray<Y.Map<unknown>>("glossary").toArray().map(readTermKind) : [];
}

/**
 * Sets the kind of every entry whose kind, read against `kinds`, is a key of
 * `renamed` to its new id, in one transaction.
 */
export function renameEntryKinds(ydoc: Y.Doc, kinds: GlossaryKinds, renamed: Record<string, string>): void {
  const entries = ydoc.getArray<Y.Map<unknown>>("glossary").toArray();
  const moves = entries.flatMap((entry) => {
    const id = siteKindOfValue(kinds, readTermKind(entry));
    const next = id !== undefined && Object.hasOwn(renamed, id) ? renamed[id] : undefined;
    return next === undefined ? [] : [{ entry, next }];
  });
  if (moves.length === 0) return;
  ydoc.transact(() => moves.forEach(({ entry, next }) => entry.set("kind", next)));
}
