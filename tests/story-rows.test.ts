/**
 * Which steps a story CSV carries, read where the editor can read it.
 *
 * `isFullyEmptyStep` decides the steps publish leaves out, and the editor's
 * scenes must leave out the same ones, so the predicate and the column
 * helpers it reads are client-safe modules the server modules take theirs
 * from. One definition each: the server module's export is the same function.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { isFullyEmptyStep } from "~/lib/story-rows";
import * as columns from "~/lib/extra-columns";
import * as serverColumns from "~/lib/extra-columns.server";

const step = (fields: Partial<Parameters<typeof isFullyEmptyStep>[0]> = {}) => ({
  kind: "media" as const,
  object_id: null,
  question: null,
  answer: null,
  extra_columns: null,
  layers: [],
  ...fields,
});

describe("isFullyEmptyStep", () => {
  it("is true for a media step with no object, text, panel or kept cell", () => {
    expect(isFullyEmptyStep(step())).toBe(true);
  });

  it("is false for a section step, whatever it holds", () => {
    expect(isFullyEmptyStep(step({ kind: "section" }))).toBe(false);
  });

  it("is false for a step with an object, a question or an answer", () => {
    expect(isFullyEmptyStep(step({ object_id: "map" }))).toBe(false);
    expect(isFullyEmptyStep(step({ question: "q" }))).toBe(false);
    expect(isFullyEmptyStep(step({ answer: "a" }))).toBe(false);
  });

  it("counts a layer only when it is a panel", () => {
    expect(isFullyEmptyStep(step({ layers: [{ title: " ", content: "\u007f" }] }))).toBe(true);
    expect(isFullyEmptyStep(step({ layers: [{ title: null, content: "Body" }] }))).toBe(false);
  });

  it("counts a kept cell, but not one in a column the framework drops first", () => {
    expect(isFullyEmptyStep(step({ extra_columns: JSON.stringify({ note: "x" }) }))).toBe(false);
    expect(isFullyEmptyStep(step({ extra_columns: JSON.stringify({ "#Note": "x", example: "y" }) }))).toBe(true);
  });
});

describe("the column helpers", () => {
  it("are one definition, which the server module re-exports", () => {
    expect(serverColumns.parseExtraColumns).toBe(columns.parseExtraColumns);
    expect(serverColumns.hasStoryRowContent).toBe(columns.hasStoryRowContent);
    expect(serverColumns.isInstructionColumnName).toBe(columns.isInstructionColumnName);
  });
});
