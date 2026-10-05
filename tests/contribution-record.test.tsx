// @vitest-environment jsdom
/**
 * The contribution record, pinned to the rules the design states rather than
 * to its rendering.
 *
 * Order belongs to the read model: `getContributionRecord` sorts members by
 * display name and `contributions-record.server.test.ts` pins that. What this
 * component owes is narrower and is what the order test here pins — it renders
 * members in the order it is handed and never reorders by value, in the legend
 * or in any table. The fixture is out of alphabetical order with its largest
 * value in the middle, so an alphabetical sort, a reverse sort and a sort by
 * value would each disturb it visibly.
 *
 * react-i18next is mocked to interpolate rather than echo the key, as in
 * ConnectedSitesCard-open-switch.test.tsx, because the writing legend is only
 * checkable through the value i18next would have interpolated.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ContributionRecord } from "~/components/features/contributions/ContributionRecord";
import { asClock } from "~/components/features/contributions/ShareBar";
import { CONTRIBUTION_KINDS } from "~/lib/contributions";
import type { ContributionKind, KindCounts, MemberContribution } from "~/lib/contributions";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "en" },
  }),
}));

// The three content measures, in the order the component shows them. Not
// exported by the component (it's a local `const MEASURES`), so pinned here
// as a literal — same value as the file's own `MEASURES` array.
const MEASURES = ["added", "edited", "words"] as const;

// The component's private fallback colour for a member with none. Not
// exported either; asserting it here pins the actual value in use.
const FALLBACK_COLOUR = "#9CA3AF";

/** jsdom normalises an inline `background` colour to `rgb(r, g, b)`. */
function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyKinds(): Record<ContributionKind, KindCounts> {
  const kinds = {} as Record<ContributionKind, KindCounts>;
  for (const kind of CONTRIBUTION_KINDS) kinds[kind] = { added: 0, edited: 0, words: 0 };
  return kinds;
}

function withKinds(
  overrides: Partial<Record<ContributionKind, Partial<KindCounts>>>
): Record<ContributionKind, KindCounts> {
  const kinds = emptyKinds();
  for (const [kind, patch] of Object.entries(overrides)) {
    kinds[kind as ContributionKind] = { ...kinds[kind as ContributionKind], ...patch };
  }
  return kinds;
}

function makeMember(over: {
  userId: number;
  displayName: string;
  color?: string | null;
  former?: boolean;
  kinds?: Record<ContributionKind, KindCounts>;
  editingSeconds?: number;
  writingSeconds?: number;
}): MemberContribution {
  return {
    userId: over.userId,
    displayName: over.displayName,
    color: over.color ?? null,
    role: over.former ? "former" : "collaborator",
    former: over.former ?? false,
    kinds: over.kinds ?? emptyKinds(),
    editingSeconds: over.editingSeconds ?? 0,
    writingSeconds: over.writingSeconds ?? 0,
  };
}

// ---------------------------------------------------------------------------
// DOM helpers — the component has no data-testid anywhere, so these locate
// structure the same way a reader would: by heading text and table shape.
// ---------------------------------------------------------------------------

/** The names in the legend chip row, in DOM order. */
function legendNames(container: HTMLElement): string[] {
  const legend = Array.from(container.querySelectorAll("div")).find(
    (d) =>
      d.className.includes("flex-wrap") &&
      d.className.includes("bg-cream") &&
      d.className.includes("rounded-md")
  );
  if (!legend) throw new Error("legend row not found");
  return Array.from(legend.children)
    .filter((el): el is HTMLElement => el.tagName === "SPAN" && !el.className.includes("ml-auto"))
    .map((el) => el.textContent ?? "");
}

/** The `<section>` for one content kind, found by its `<h3>` heading text. */
function kindSection(container: HTMLElement, kind: ContributionKind): HTMLElement {
  const heading = `kinds.${kind}`;
  const section = Array.from(container.querySelectorAll("section")).find(
    (s) => s.querySelector("h3")?.textContent === heading
  );
  if (!section) throw new Error(`section not found for kind ${kind}`);
  return section;
}

/** The time `<section>`, found by its `<h2>` heading text. */
function timeSection(container: HTMLElement): HTMLElement {
  const section = Array.from(container.querySelectorAll("section")).find(
    (s) => s.querySelector("h2")?.textContent === "time.heading"
  );
  if (!section) throw new Error("time section not found");
  return section;
}

/** The names in a section's table body, in row order. */
function tableRowNames(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll("tbody tr")).map(
    (tr) => tr.querySelector("td")?.textContent ?? ""
  );
}

/** The three ShareBar root elements in a kind section, in MEASURES order. */
function measureBarRoots(section: HTMLElement): HTMLElement[] {
  const wrapper = Array.from(section.querySelectorAll("div")).find(
    (d) => d.className.includes("flex-col") && d.className.includes("gap-[5px]")
  );
  if (!wrapper) throw new Error("measure bar wrapper not found");
  return Array.from(wrapper.children) as HTMLElement[];
}

/** A ShareBar root's segment divs (its track is the root's 2nd child). */
function barSegments(barRoot: HTMLElement): HTMLElement[] {
  return Array.from(barRoot.children[1].children) as HTMLElement[];
}

/** A ShareBar root's total span (the root's 3rd child). */
function barTotal(barRoot: HTMLElement): HTMLElement {
  return barRoot.children[2] as HTMLElement;
}

/** Every leaf element under `root` whose trimmed text is pure digits. */
function numericLeafTexts(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let el = walker.currentNode as HTMLElement | null;
  while (el) {
    if (el.children.length === 0) {
      const text = el.textContent?.trim() ?? "";
      if (/^\d+$/.test(text)) out.push(text);
    }
    el = walker.nextNode() as HTMLElement | null;
  }
  return out;
}

const BASE_PROPS = { projectTitle: "Test Project" };

// ---------------------------------------------------------------------------
// Alphabetical, never by value
// ---------------------------------------------------------------------------

describe("ContributionRecord: order", () => {
  it("renders members in exactly the order passed — never reorders by value, in the legend or in any table", () => {
    // Deliberately out of alphabetical order, with the largest value in the
    // middle: an alphabetical sort, a reverse sort and a sort by value would
    // each put these three in a different order from the one given, so any
    // reordering the component introduced would show.
    const zoe = makeMember({
      userId: 3,
      displayName: "Zoe Bravo",
      kinds: withKinds({ steps: { added: 5 } }),
    });
    const amy = makeMember({
      userId: 1,
      displayName: "Amy Chen",
      kinds: withKinds({ steps: { added: 9 } }),
    });
    const mona = makeMember({
      userId: 2,
      displayName: "Mona Diaz",
      kinds: withKinds({ steps: { added: 1 } }),
    });
    const members = [zoe, amy, mona];
    const inputOrder = ["Zoe Bravo", "Amy Chen", "Mona Diaz"];

    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    expect(legendNames(container)).toEqual(inputOrder);
    for (const kind of CONTRIBUTION_KINDS) {
      expect(tableRowNames(kindSection(container, kind))).toEqual(inputOrder);
    }
    expect(tableRowNames(timeSection(container))).toEqual(inputOrder);
  });
});

// ---------------------------------------------------------------------------
// No totals across kinds or measures
// ---------------------------------------------------------------------------

describe("ContributionRecord: no totals across kinds or measures", () => {
  it("shows only per-kind-per-measure numbers in the made section — no person or cross-kind total appears anywhere", () => {
    const amy = makeMember({
      userId: 1,
      displayName: "Amy Chen",
      kinds: withKinds({
        steps: { added: 3, edited: 5, words: 70 },
        panels: { added: 2, edited: 0, words: 0 },
      }),
    });
    const zoe = makeMember({
      userId: 2,
      displayName: "Zoe Bravo",
      kinds: withKinds({
        panels: { added: 11, edited: 13, words: 90 },
      }),
    });
    const members = [amy, zoe];

    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    // Every number that should legitimately appear in the "made" section: for
    // each kind and measure, the group total plus each member's own cell —
    // nothing else. If any code path summed a person across kinds or measures
    // and rendered it, this multiset would gain an element and fail to match.
    const expected: number[] = [];
    for (const kind of CONTRIBUTION_KINDS) {
      for (const measure of MEASURES) {
        const values = members.map((m) => m.kinds[kind][measure] ?? 0);
        expected.push(values.reduce((a, v) => a + v, 0));
        expected.push(...values);
      }
    }

    const actual: number[] = [];
    for (const kind of CONTRIBUTION_KINDS) {
      actual.push(...numericLeafTexts(kindSection(container, kind)).map(Number));
    }

    expect(actual.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// Bars are within one kind and one measure
// ---------------------------------------------------------------------------

describe("ContributionRecord: bars are within one kind and one measure", () => {
  it("uses each person's raw count as the segment's flex value, with no cross-kind normalisation", () => {
    const amy = makeMember({
      userId: 1,
      displayName: "Amy Chen",
      kinds: withKinds({
        panels: { added: 3 },
        // Same measure, same person, a different kind with a very different
        // group total (12 vs panels' 4) — if flex were normalised against
        // some shared or cross-kind scale, this segment would not also read
        // "3".
        steps: { added: 3 },
      }),
    });
    const bea = makeMember({
      userId: 2,
      displayName: "Bea Ortiz",
      kinds: withKinds({
        panels: { added: 1 },
        steps: { added: 9 },
      }),
    });
    const members = [amy, bea];

    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    const panelsAddedBar = measureBarRoots(kindSection(container, "panels"))[0];
    const panelsSegments = barSegments(panelsAddedBar);
    expect(panelsSegments.map((s) => s.style.flexGrow)).toEqual(["3", "1"]);

    const stepsAddedBar = measureBarRoots(kindSection(container, "steps"))[0];
    const stepsSegments = barSegments(stepsAddedBar);
    // Amy's segment reads "3" in both kinds — the raw count, not a share of
    // some quantity that differs between the two rows.
    expect(stepsSegments.map((s) => s.style.flexGrow)).toEqual(["3", "9"]);
  });
});

// ---------------------------------------------------------------------------
// Zero is visible, uncounted is a dash
// ---------------------------------------------------------------------------

describe("ContributionRecord: zero vs uncounted", () => {
  it("renders 0 faint (not a dash) and null as the uncounted string, also faint — in a measure that is not all-null", () => {
    const zero = makeMember({
      userId: 1,
      displayName: "Amy Chen",
      kinds: withKinds({ objects: { words: 0 } }),
    });
    const nullMember = makeMember({
      userId: 2,
      displayName: "Bea Ortiz",
      kinds: withKinds({ objects: { words: null as unknown as number } }),
    });
    const members = [zero, nullMember];

    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    const rows = Array.from(kindSection(container, "objects").querySelectorAll("tbody tr"));
    const [zeroRow, nullRow] = rows;
    // words is the 3rd measure column (added, edited, words), so the 4th <td>
    // counting the name column.
    const zeroWordsCell = zeroRow.querySelectorAll("td")[3];
    const nullWordsCell = nullRow.querySelectorAll("td")[3];

    expect(zeroWordsCell.textContent).toBe("0");
    expect(zeroWordsCell.className).toContain("text-fg-faint");

    expect(nullWordsCell.textContent).toBe("uncounted");
    expect(nullWordsCell.className).toContain("text-fg-faint");
  });

  it("renders an empty track and a dash total for a measure nobody counted at all (all-null)", () => {
    const a = makeMember({
      userId: 1,
      displayName: "Amy Chen",
      kinds: withKinds({ pages: { words: null as unknown as number } }),
    });
    const b = makeMember({
      userId: 2,
      displayName: "Bea Ortiz",
      kinds: withKinds({ pages: { words: null as unknown as number } }),
    });
    const members = [a, b];

    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    const wordsBar = measureBarRoots(kindSection(container, "pages"))[2];
    expect(barSegments(wordsBar)).toHaveLength(0);
    const total = barTotal(wordsBar);
    expect(total.textContent).toBe("uncounted");
    expect(total.className).toContain("text-fg-faint");
  });
});

// ---------------------------------------------------------------------------
// The empty-state note
// ---------------------------------------------------------------------------

describe("ContributionRecord: empty-state note", () => {
  it("shows the predates-collection note, with every kind block and the time section still present, when hasWordsAndTime is false", () => {
    const members = [makeMember({ userId: 1, displayName: "Amy Chen" })];
    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={false} />
    );

    expect(screen.getByText("predatesCollection")).toBeTruthy();
    for (const kind of CONTRIBUTION_KINDS) {
      expect(() => kindSection(container, kind)).not.toThrow();
    }
    expect(() => timeSection(container)).not.toThrow();
  });

  it("hides the note when hasWordsAndTime is true", () => {
    const members = [makeMember({ userId: 1, displayName: "Amy Chen" })];
    render(<ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />);
    expect(screen.queryByText("predatesCollection")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

describe("ContributionRecord: time", () => {
  it("formats editing and writing as h:mm via asClock, dashes the writing share when editing is 0, and rounds it otherwise", () => {
    const idle = makeMember({
      userId: 1,
      displayName: "Amy Chen",
      editingSeconds: 0,
      writingSeconds: 0,
    });
    const worked = makeMember({
      userId: 2,
      displayName: "Bea Ortiz",
      editingSeconds: 3600, // 1:00
      writingSeconds: 1500, // 0:25 — share round(1500/3600*100) = 42
    });
    const members = [idle, worked];

    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    const rows = Array.from(timeSection(container).querySelectorAll("tbody tr"));
    const [idleRow, workedRow] = rows;
    const [, idleEditing, idleWriting, idleShare] = idleRow.querySelectorAll("td");
    const [, workedEditing, workedWriting, workedShare] = workedRow.querySelectorAll("td");

    expect(idleEditing.textContent).toBe(asClock(0));
    expect(idleWriting.textContent).toBe(asClock(0));
    expect(idleWriting.className).toContain("text-fg-faint"); // writingSeconds === 0
    expect(idleShare.textContent).toContain("uncounted"); // editingSeconds === 0 → share null

    expect(workedEditing.textContent).toBe(asClock(3600));
    expect(workedEditing.textContent).toBe("1:00");
    expect(workedWriting.textContent).toBe(asClock(1500));
    expect(workedWriting.textContent).toBe("0:25");
    expect(workedShare.textContent).toContain("42%");
  });

  it("carries the group's writing total in the writing legend", () => {
    const a = makeMember({ userId: 1, displayName: "Amy Chen", editingSeconds: 100, writingSeconds: 0 });
    const b = makeMember({ userId: 2, displayName: "Bea Ortiz", editingSeconds: 3600, writingSeconds: 1500 });
    const members = [a, b];

    render(<ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />);

    // writingTotal = 0 + 1500 = 1500 → asClock(1500) = "0:25"
    const expectedTotal = asClock(1500);
    expect(expectedTotal).toBe("0:25");
    expect(
      screen.getByText(`time.writingLegend:${JSON.stringify({ total: expectedTotal })}`)
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

describe("ContributionRecord: print", () => {
  it("gives every kind block and the time section break-inside: avoid", () => {
    const members = [makeMember({ userId: 1, displayName: "Amy Chen" })];
    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    for (const kind of CONTRIBUTION_KINDS) {
      expect(kindSection(container, kind).style.breakInside).toBe("avoid");
    }
    expect(timeSection(container).style.breakInside).toBe("avoid");
  });
});

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

describe("ContributionRecord: colour", () => {
  it("uses a member's presence colour for their legend dot, bar segment and table dot — and the fallback for a member with none", () => {
    const withColour = makeMember({
      userId: 1,
      displayName: "Amy Chen",
      color: "#ABCDEF",
      kinds: withKinds({ panels: { added: 3 } }),
    });
    const withoutColour = makeMember({
      userId: 2,
      displayName: "Bea Ortiz",
      color: null,
      kinds: withKinds({ panels: { added: 1 } }),
    });
    const members = [withColour, withoutColour];

    const { container } = render(
      <ContributionRecord {...BASE_PROPS} members={members} hasWordsAndTime={true} />
    );

    const legend = Array.from(container.querySelectorAll("div")).find(
      (d) =>
        d.className.includes("flex-wrap") &&
        d.className.includes("bg-cream") &&
        d.className.includes("rounded-md")
    )!;
    const [amyLegendDot, beaLegendDot] = legend.querySelectorAll("span > span");
    expect((amyLegendDot as HTMLElement).style.background).toBe(rgbOf("#ABCDEF"));
    expect((beaLegendDot as HTMLElement).style.background).toBe(rgbOf(FALLBACK_COLOUR));

    const panelsBar = measureBarRoots(kindSection(container, "panels"))[0];
    const [amySegment, beaSegment] = barSegments(panelsBar);
    expect(amySegment.style.background).toBe(rgbOf("#ABCDEF"));
    expect(beaSegment.style.background).toBe(rgbOf(FALLBACK_COLOUR));

    const rows = Array.from(kindSection(container, "panels").querySelectorAll("tbody tr"));
    const amyTableDot = rows[0].querySelector("td span span") as HTMLElement;
    const beaTableDot = rows[1].querySelector("td span span") as HTMLElement;
    expect(amyTableDot.style.background).toBe(rgbOf("#ABCDEF"));
    expect(beaTableDot.style.background).toBe(rgbOf(FALLBACK_COLOUR));
  });
});
