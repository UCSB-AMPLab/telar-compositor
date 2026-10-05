/**
 * A fake database serving one story to `buildPublishFileSet`, for the story
 * files and canonical content tests.
 *
 * Kept apart from the fixtures module, and importing nothing from the app at
 * runtime: a `vi.mock("~/lib/db.server")` factory that loads a module which
 * itself reaches `db.server` waits on its own mock and never resolves.
 *
 * @version v1.5.0-beta
 */

import type { D1Story } from "./story-canonical-fixtures";

let served: D1Story | null = null;
let servedOthers: Array<{ id: number; story_id: string; source_path: string | null }> = [];

/** Further stories, with no steps, served beside the story until the next call. */
export function serveOtherStories(others: Array<{ id: number; story_id: string; source_path: string | null }>): void {
  servedOthers = others;
}

/** The story the fake database serves until the next call. */
export function serveStory(story: D1Story | null): void {
  served = story;
}

function tableName(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);
}

/**
 * The column and value of a drizzle `eq(column, value)` condition. Any other
 * shape throws, so a query this fake cannot answer faithfully fails the test
 * instead of being served something.
 */
function equality(condition: unknown): { column: string; value: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  const column = chunks.find((c) => (c as { constructor?: { name?: string } })?.constructor?.name !== "StringChunk" && typeof (c as { name?: unknown }).name === "string") as { name: string } | undefined;
  const param = chunks.find((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "Param") as { value: unknown } | undefined;
  if (!column || !param) throw new Error("fake db: only eq(column, value) conditions are answered");
  return { column: column.name, value: param.value };
}

/**
 * `getDb` for `vi.mock("~/lib/db.server")`. Each read is answered from the
 * served story by its `where` condition: steps by `story_id`, layers by
 * `step_id`. The objects and glossary reads get none.
 */
export function fakeGetDb() {
  const story = served;
  return {
    select: () => {
      let table = "";
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = tableName(t);
        return chain;
      };
      chain.where = (condition: unknown) => {
        let rows: unknown[] = [];
        if (story && table === "stories") {
          rows = [{
            ...story.story,
            project_id: 1,
            title: story.story.story_id,
            subtitle: null,
            byline: null,
            order: 0,
            private: false,
            draft: false,
            show_sections: false,
          }, ...servedOthers.map((o) => ({
            ...o, project_id: 1, title: o.story_id, subtitle: null, byline: null, order: 1,
            private: false, draft: false, show_sections: false,
          }))];
        } else if (story && table === "steps") {
          const { column, value } = equality(condition);
          if (column !== "story_id") throw new Error(`fake db: steps by ${column}`);
          rows = value === story.story.id ? story.stepRows : [];
        } else if (story && table === "layers") {
          const { column, value } = equality(condition);
          if (column !== "step_id") throw new Error(`fake db: layers by ${column}`);
          rows = story.layerRows.filter((l) => l.step_id === value);
        }
        return Object.assign(Promise.resolve(rows), chain);
      };
      // A read ordered with `.orderBy()` (objects, in `objectsSheetOrder`) answers the same rows.
      chain.orderBy = function (this: unknown) { return this; };
      chain.limit = () => Promise.resolve([]);
      return chain;
    },
  };
}

