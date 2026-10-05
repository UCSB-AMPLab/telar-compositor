/**
 * What a republish does when the existing file yields no reading at all.
 *
 * `extractCommentRows` answers an empty list for a file that holds no comments,
 * so it must not answer the same thing for a file whose rows and ranges could
 * not be matched: the two are indistinguishable to every caller, and the
 * publish would go out with the author's instruction rows gone and nothing left
 * for the next publish to carry. The reading is refused in its own right, so
 * the refusal is its own answer.
 *
 * The reading is mocked because no CSV reaches that branch: the delimiter, the
 * terminator and the record boundaries all come from Papa's own parse of the
 * file, and the range texts are read back under the same pair. What is under
 * test is what the serializers do with a refusal, not how one arises.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/csv-record-scan.server", () => ({
  readCsvSourceRows: () => null,
  removeObjectRecord: () => ({ status: "unusable" }),
}));

const { CsvCommentExtractionError, extractCommentRows, serializeObjectsCsv } = await import(
  "~/lib/csv-export.server"
);
const { serializeGlossaryCsv, serializeProjectCsv, serializeStory } = await import(
  "~/lib/publish.server"
);

const EXISTING = "object_id,title\n# una instrucción\nobj-1,Un objeto\n";

describe("a CSV that yields no reading", () => {
  it("refuses to answer `no comments` for it", () => {
    expect(() => extractCommentRows(EXISTING)).toThrow(CsvCommentExtractionError);
  });

  it("says in the message that publishing would drop the rows", () => {
    expect(() => extractCommentRows(EXISTING)).toThrow(/would drop them/);
  });

  // Every serializer that preserves comments carries the refusal up to the
  // publish action, which reports `publish_failed` and commits nothing
  // (app/routes/_app.publish.tsx, the catch around the file-set assembly).
  it("stops the objects serializer", () => {
    expect(() =>
      serializeObjectsCsv(
        [
          {
            object_id: "obj-1",
            title: "Un objeto",
            featured: null,
            creator: null,
            description: null,
            source_url: null,
            period: null,
            year: null,
            medium_genre: null,
            subjects: null,
            source: null,
            credit: null,
            thumbnail: null,
            alt_text: "alt",
            dimensions: null,
            extra_columns: null,
          },
        ],
        EXISTING,
      ),
    ).toThrow(CsvCommentExtractionError);
  });

  it("stops the project serializer", () => {
    expect(() => serializeProjectCsv([], EXISTING)).toThrow(CsvCommentExtractionError);
  });

  it("stops the story serializer", () => {
    expect(() => serializeStory([], "una-historia", EXISTING)).toThrow(CsvCommentExtractionError);
  });

  it("stops the glossary serializer", () => {
    expect(() => serializeGlossaryCsv([], EXISTING)).toThrow(CsvCommentExtractionError);
  });
});
