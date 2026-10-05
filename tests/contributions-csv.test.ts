/**
 * The export, held to the same rules as the page it comes from.
 *
 * A spreadsheet is where a record stops being a record and starts being a
 * gradebook, so the properties worth pinning are the ones that would let that
 * happen quietly: a total nobody asked for, a zero standing in for a measure
 * nobody collected, or a row order that ranks.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { toContributionCsv } from "~/lib/contributions-csv";
import { CONTRIBUTION_KINDS } from "~/lib/contributions";
import type { MemberContribution } from "~/lib/contributions";

function member(overrides: Partial<MemberContribution> = {}): MemberContribution {
  const kinds = Object.fromEntries(
    CONTRIBUTION_KINDS.map((k) => [k, { added: 0, edited: 0, words: null }]),
  ) as MemberContribution["kinds"];
  return {
    userId: 1,
    displayName: "Ana",
    color: "#E47A6F",
    role: "convenor",
    former: false,
    kinds,
    editingSeconds: 0,
    writingSeconds: 0,
    ...overrides,
  };
}

const lines = (csv: string) => csv.trim().split("\n");

describe("the exported file", () => {
  it("names the project in a comment, not in a column", () => {
    const csv = toContributionCsv("Mujeres y trabajo", [member()]);

    expect(lines(csv)[0]).toBe("# Mujeres y trabajo");
    expect(lines(csv)[1].startsWith("name,role,")).toBe(true);
  });

  it("gives one row per person, in the order it was handed", () => {
    const csv = toContributionCsv("Sitio", [
      member({ userId: 1, displayName: "Ana" }),
      member({ userId: 2, displayName: "Beatriz" }),
    ]);

    expect(lines(csv)).toHaveLength(4);
    expect(lines(csv)[2].startsWith("Ana,")).toBe(true);
    expect(lines(csv)[3].startsWith("Beatriz,")).toBe(true);
  });

  it("leaves an uncounted measure empty rather than writing a zero", () => {
    // An empty cell reads as no data everywhere; a nought asserts that this
    // person wrote nothing on a project where nobody was ever counted.
    const csv = toContributionCsv("Sitio", [member()]);
    const header = lines(csv)[1].split(",");
    const row = lines(csv)[2].split(",");

    expect(row[header.indexOf("steps_words")]).toBe("");
    expect(row[header.indexOf("steps_added")]).toBe("0");
  });

  it("writes time in minutes, which a spreadsheet can add up", () => {
    const csv = toContributionCsv("Sitio", [
      member({ editingSeconds: 12180, writingSeconds: 5760 }),
    ]);
    const header = lines(csv)[1].split(",");
    const row = lines(csv)[2].split(",");

    expect(row[header.indexOf("editing_minutes")]).toBe("203");
    expect(row[header.indexOf("writing_minutes")]).toBe("96");
  });

  it("carries no total across measures and none across kinds", () => {
    const csv = toContributionCsv("Sitio", [member()]);
    const header = lines(csv)[1];

    expect(header).not.toMatch(/total/i);
    expect(lines(csv)).not.toContainEqual(expect.stringMatching(/^total/i));
  });

  it("keeps a comma in someone's name inside its own field", () => {
    const csv = toContributionCsv("Sitio", [member({ displayName: "Cobo, Juan" })]);

    expect(lines(csv)[2].startsWith('"Cobo, Juan",convenor,')).toBe(true);
  });

  it("has a column for every kind and measure the record shows", () => {
    const header = lines(toContributionCsv("Sitio", [member()]))[1].split(",");

    for (const kind of CONTRIBUTION_KINDS) {
      for (const measure of ["added", "edited", "words"]) {
        expect(header).toContain(`${kind}_${measure}`);
      }
    }
  });
});
