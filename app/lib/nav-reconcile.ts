/**
 * reconcileNavPageSlugs — follow a Durable Object re-key through
 * `config.navigation`.
 *
 * A navigation entry addresses a page by `slug` and carries no row id, so the
 * link survives only as long as the slug does. The DO breaks that: when two
 * live pages collide on one human key it re-keys the loser rather than
 * deleting it (`deduplicateYArray`, `workers/collaboration.ts`), which is what
 * keeps another member's page from being destroyed by a rename. `pages[i].slug`
 * moves; `config.navigation` is plain JSON the re-key does not touch, so the
 * menu keeps the old slug — the keeper ends up with two entries and the
 * re-keyed page with none. `navigation_json` is the authority the published
 * `_data/navigation.yml` is derived from, so that stale copy is what ships.
 *
 * The DO writes `config.navigation` in one place only: `/ingest-sync`'s page
 * arms, which remove the entries naming a page they remove, re-point the
 * entries naming a page they rename, and add the entry GitHub's menu gives a
 * page they insert, each in the transaction that changes the page
 * (`workers/page-menu-entries.ts`). Those arms know which page each entry
 * names, since they change the page by row id; the re-key does not.
 *
 * The repair belongs on the client because this is the only place holding both
 * the page list and the nav array, and because the association it has to
 * rebuild — which entry meant which page — is not recoverable from either one
 * alone. Nothing in a nav entry names its page durably: it addresses the page
 * by the very slug the re-key moved, and every other field on it is the user's
 * own text. So the repair acts only where the association is *determined* and
 * declines everywhere else. Two things determine it:
 *
 *   - the mint shape. A re-key comes from `makeUniqueSlug`, which appends
 *     `-2`, `-3`, … to the colliding base. A live page slug matching
 *     `<group slug>-<digits>` with no entry of its own is therefore a
 *     re-key of that group, and nothing else is. This says which pages are in
 *     play; it never says which entry is whose.
 *   - interchangeability. When every entry in a slug group is identical field
 *     for field, no assignment among them can swap an identity, lose a label
 *     or move a hidden item into the published menu — every assignment yields
 *     the same array. Two pages sharing a title lands here, and that is the
 *     ordinary way the collision happens: the slug is generated from the
 *     title, so equal titles collide and their menu labels track those titles.
 *
 * A label is not one of them. `_app.pages.tsx` syncs a label to its page title
 * only while the stored label still equals the title it last saw, so a label
 * typed in the NavigationEditor is left alone for good — which makes it free
 * text, and free text can equal anything, including another page's title. An
 * entry whose custom label reads like the keeper's title is then picked as the
 * keeper, and the entry that really belonged to the keeper is handed to the
 * re-keyed page by elimination: both menu identities move to the wrong page.
 * There is no narrower reading that escapes this, because "the label equals a
 * title" and "the label equals a title but the entry is not that page's" are
 * the same document. Page titles are therefore never read here at all.
 *
 * Position is not one of them either. The DO picks its keeper by D1 row id,
 * never by menu order, so ordering a group by index and calling the first one
 * the keeper is a coin flip. Where nothing determines the association the
 * group is left exactly as it is: a duplicate link is visible and the user can
 * delete it, whereas a swapped identity looks correct and a destroyed label is
 * gone.
 *
 * For the same reason the repair rewrites `slug` and nothing else. The slug is
 * the machine reference the re-key invalidated; the label is the name the user
 * chose, and a custom label is legitimate — the route's own label-sync path
 * exists to protect it. A repair that renames menu items is not a repair.
 *
 * Deliberately conservative in the remaining directions too: a page with no
 * entry at all stays out of the menu (staying out is a state the user can
 * hold), and a dangling entry, whose page is absent from the list, is left
 * where it is. The only entries this touches are the surplus members of a slug
 * group — a duplicate link no editing path can produce.
 *
 * Every connected client runs this off the same broadcast, and a nav entry is
 * rewritten as delete + insert, so two clients can each land an entry for the
 * re-keyed page. That state is a slug group of its own with no page left to
 * claim it, so the next pass collapses it: the function is a fixpoint.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import type { NavItemLike } from "~/lib/yjs-helpers";

export interface ReconcilePage {
  slug: string;
  /**
   * Carried by the caller's page records and deliberately never read: a title
   * cannot establish which menu entry belongs to which page (see above). It is
   * accepted rather than stripped so the constraint stays visible at the
   * boundary, and a test pins that varying every title changes nothing.
   */
  title?: string;
}

/** True when `candidate` is `base` carrying a `makeUniqueSlug` mint suffix. */
function isMintedFrom(candidate: string, base: string): boolean {
  if (!candidate.startsWith(`${base}-`)) return false;
  const suffix = candidate.slice(base.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

/**
 * Key-order-independent identity for a nav entry.
 *
 * Two entries are interchangeable only if every field matches, `visible`
 * included: same label but different visibility means swapping them would
 * publish a menu item the user hid. Entries reaching here are plain JSON —
 * the caller has already excluded `Y.Map` and non-objects — so a sorted-key
 * re-serialisation is a total comparison, and key order is not part of the
 * entry's meaning.
 */
function entryIdentity(entry: Record<string, unknown>): string {
  const keys = Object.keys(entry).sort();
  return JSON.stringify(keys.map((k) => [k, entry[k]]));
}

/**
 * The change signature the repair's caller re-runs on.
 *
 * `reconcileNavPageSlugs` is driven from an effect, and an effect re-runs only
 * on the dependencies it is given. A dependency list written by hand beside the
 * function is a second copy of what the function reads, and the two drift: a
 * field the repair consumes but the list omits leaves a re-keyed page unlinked
 * until some unrelated change happens to re-run it. So the signature is built
 * here, from the same reads, and the caller depends on its output.
 */
export function navReconcileSignature(
  pages: readonly ReconcilePage[],
  entries: readonly unknown[],
): string {
  return JSON.stringify([
    pages.map((p) => p.slug),
    entries.map((entry) =>
      entry !== null && typeof entry === "object"
        ? entryIdentity(entry as Record<string, unknown>)
        : String(entry),
    ),
  ]);
}

export function reconcileNavPageSlugs(
  navArray: Y.Array<unknown>,
  pages: readonly ReconcilePage[],
  options: { mutate?: boolean; ydoc?: Y.Doc } = {},
): { items: NavItemLike[]; repointed: number; removed: number } {
  const raw = navArray.toArray();
  const entries = raw.map((entry) =>
    entry !== null && typeof entry === "object" && !(entry instanceof Y.Map)
      ? (entry as Record<string, unknown>)
      : null,
  );

  const slugAt = (i: number): string => {
    const entry = entries[i];
    if (!entry || entry.type !== "page") return "";
    return typeof entry.slug === "string" ? entry.slug.trim() : "";
  };
  const pageSlugs: string[] = [];
  const seenSlugs = new Set<string>();
  for (const page of pages) {
    const slug = (page.slug ?? "").trim();
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    pageSlugs.push(slug);
  }
  // Nothing to reconcile against — an unsynced document, not a broken menu.
  if (pageSlugs.length === 0) {
    return { items: raw as NavItemLike[], repointed: 0, removed: 0 };
  }

  const groups = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const slug = slugAt(i);
    if (!slug) continue;
    const group = groups.get(slug);
    if (group) group.push(i);
    else groups.set(slug, [i]);
  }

  // A live page slug no entry claims is where a re-keyed page's link went.
  const unclaimed = pageSlugs.filter((slug) => !groups.has(slug));
  if (unclaimed.length === 0 && [...groups.values()].every((g) => g.length === 1)) {
    return { items: raw as NavItemLike[], repointed: 0, removed: 0 };
  }

  const surplus: number[] = [];
  for (const [, indices] of groups) {
    if (indices.length === 1) continue;
    // A group is repairable only when its entries are identical field for
    // field. Then calling the first one the keeper decides nothing: every
    // assignment among them produces the same array, so no menu item can end
    // up on the wrong page. A group whose entries differ in any field is left
    // whole — the document never recorded which page an entry was minted for,
    // so choosing between them is a guess, and a wrong guess hands the
    // re-keyed page another page's menu item under a name that looks right.
    const first = entryIdentity(entries[indices[0]] as Record<string, unknown>);
    const interchangeable = indices.every(
      (i) => entryIdentity(entries[i] as Record<string, unknown>) === first,
    );
    if (!interchangeable) continue;
    for (const i of indices.slice(1)) surplus.push(i);
  }
  surplus.sort((a, b) => a - b);

  const claimed = new Set<string>();
  const repoints = new Map<number, string>();
  const stranded = new Set<number>();
  for (const i of surplus) {
    const base = slugAt(i);
    const candidates = unclaimed.filter(
      (slug) => !claimed.has(slug) && isMintedFrom(slug, base),
    );
    // No re-keyed page to receive it: the entry duplicates one this pass is
    // keeping, which is the state two clients repairing at once produce, and
    // it goes.
    if (candidates.length === 0) continue;
    // One free minted slug means the target follows by elimination: the group
    // was interchangeable, so this entry is the re-keyed page's as much as any
    // other, and there is exactly one page for it to be. Two or more free
    // minted slugs is a choice nothing decides, and the entry stays where it
    // is rather than be pointed at a page picked by list order.
    if (candidates.length > 1) {
      stranded.add(i);
      continue;
    }
    claimed.add(candidates[0]);
    repoints.set(i, candidates[0]);
  }

  const removals = surplus.filter((i) => !repoints.has(i) && !stranded.has(i));
  if (repoints.size === 0 && removals.length === 0) {
    return { items: raw as NavItemLike[], repointed: 0, removed: 0 };
  }

  // The entry keeps everything it carried except the one field the re-key
  // invalidated: the slug it points at. The label is the user's, and a label
  // that diverges from the page title is a state the route deliberately
  // preserves, so re-pointing a link must not rename it.
  const rewritten = new Map<number, Record<string, unknown>>();
  for (const [i, target] of repoints) {
    rewritten.set(i, {
      ...(entries[i] as Record<string, unknown>),
      slug: target,
    });
  }

  const next: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (removals.includes(i)) continue;
    next.push(rewritten.get(i) ?? raw[i]);
  }

  if (options.mutate && options.ydoc) {
    // Touch only the affected slots, highest index first so the lower ones stay
    // valid, rather than replacing the array wholesale: every untouched entry
    // keeps its identity, so a peer reordering the menu at the same moment
    // merges instead of losing its move.
    const affected = [...repoints.keys(), ...removals].sort((a, b) => b - a);
    options.ydoc.transact(() => {
      for (const i of affected) {
        navArray.delete(i, 1);
        const entry = rewritten.get(i);
        if (entry) navArray.insert(i, [entry]);
      }
    });
  }

  return {
    items: next as NavItemLike[],
    repointed: repoints.size,
    removed: removals.length,
  };
}
