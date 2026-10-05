/**
 * The bar the contribution record is drawn with, and the formatting the record
 * shares with the sidebar.
 *
 * One bar is one measure of one kind — steps added, panels edited, words in
 * object records — split into a segment per person and normalised to the group's
 * total for that measure alone. Nothing is ever drawn on a scale shared between
 * kinds: fourteen steps and fourteen hundred words are not comparable
 * quantities, and a bar that put them on one axis would invite exactly the
 * reading the record exists to prevent.
 *
 * So the bar answers "who, and in what proportion" and the table beside it
 * answers "how many". The absolute numbers live only in the table.
 *
 * @version v1.5.0-beta
 */

/** One person's share of one measure. */
export interface Share {
  userId: number;
  color: string;
  value: number;
}

/** A person's presence colour at 40% alpha, for the remainder inside a bar. */
export function tint(color: string): string {
  return `${color}66`;
}

/**
 * Seconds as `h:mm`.
 *
 * Hours and minutes because the numbers are hours of coursework, and a seconds
 * figure would imply a precision the one-minute clock does not have.
 */
export function asClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

interface ShareBarProps {
  label: string;
  shares: Share[];
  /** What the table would total, rendered at the end of the bar. */
  total: string;
  /** Nobody counted this measure: an empty track and an em dash. */
  uncounted?: boolean;
  /** Track height in pixels — the time bar is taller than the content bars. */
  height?: number;
}

/**
 * A labelled track, its segments in the order they were given.
 *
 * The order is the caller's and is always alphabetical: sorting segments by size
 * would rank people inside the one place the record shows them together.
 * Segments worth nothing are dropped rather than drawn at zero width, so a
 * person who did none of one thing leaves no sliver behind to be misread.
 */
export function ShareBar({ label, shares, total, uncounted = false, height = 11 }: ShareBarProps) {
  const drawn = shares.filter((s) => s.value > 0);
  const sum = drawn.reduce((a, s) => a + s.value, 0);

  return (
    <div className="flex items-center gap-2" style={{ minHeight: height + 5 }}>
      <span className="w-16 shrink-0 text-right text-[11.5px] text-fg-subtle">{label}</span>
      <div
        className="flex flex-1 gap-px overflow-hidden rounded-[2px] bg-cream-dark"
        style={{ height }}
      >
        {sum > 0 && drawn.map((share) => (
          <div key={share.userId} style={{ flex: share.value, background: share.color }} />
        ))}
      </div>
      <span
        className={`w-12 shrink-0 text-right text-[12.5px] tabular-nums ${
          uncounted ? "text-fg-faint" : "text-fg-muted"
        }`}
      >
        {total}
      </span>
    </div>
  );
}

/**
 * The time bar: one segment per person, each split into the part they spent
 * writing and the part they spent on everything else.
 *
 * The nesting is the point. Editing and writing are not two measures to be set
 * side by side — one contains the other, and a convenor's afternoon of
 * cataloguing images reads as a long segment with a short bright head. Drawn as
 * two bars it would read as two activities, and as one bar of writing alone it
 * would report that afternoon as idleness.
 */
export function NestedTimeBar({ label, people, total }: {
  label: string;
  people: Array<{ userId: number; color: string; editing: number; writing: number }>;
  total: string;
}) {
  const drawn = people.filter((p) => p.editing > 0);

  return (
    <div className="flex items-center gap-2" style={{ minHeight: 22 }}>
      <span className="w-16 shrink-0 text-right text-[11.5px] text-fg-subtle">{label}</span>
      <div className="flex h-4 flex-1 gap-px overflow-hidden rounded-[2px] bg-cream-dark">
        {drawn.map((person) => (
          <div key={person.userId} className="flex" style={{ flex: person.editing }}>
            <div style={{ flex: Math.min(person.writing, person.editing), background: person.color }} />
            <div
              style={{
                flex: Math.max(0, person.editing - person.writing),
                background: tint(person.color),
              }}
            />
          </div>
        ))}
      </div>
      <span className="w-12 shrink-0 text-right text-[12.5px] tabular-nums text-fg-muted">
        {total}
      </span>
    </div>
  );
}
