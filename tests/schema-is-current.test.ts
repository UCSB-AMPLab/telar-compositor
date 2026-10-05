/**
 * `app/db/schema.ts` must describe the database the migrations build.
 *
 * The two are maintained by hand and by different acts: a migration is
 * hand-written SQL applied to D1, and the Drizzle schema is the TypeScript
 * every server module reads and writes through. Nothing forces them to agree.
 * When they disagree the failure is not a compile error — it is a query that
 * typechecks, passes review, and fails against the real database, or worse,
 * a column typed `string | null` that is never null and a branch written to
 * handle a case that cannot occur.
 *
 * `tests/helpers/d1-memory.ts` already replays the whole migration chain into
 * SQLite, so the true schema is available to be read back. This compares what
 * it built against what `schema.ts` declares: the set of tables, and for each
 * table the set of columns, their SQL types, their nullability, their primary
 * keys, and the uniqueness rules that can make a write fail.
 *
 * Two things it deliberately does not compare.
 *
 * Non-unique indexes constrain nothing a writer can trip over; they are the
 * migrations' business, and `schema.ts` declares none.
 *
 * Column DEFAULTS, because the two files mean different things by the word.
 * `$defaultFn` runs in the application before the insert; a SQL default runs
 * in the database when a column is omitted. A column can honestly have one,
 * the other, or both.
 *
 * @version v1.5.0-beta
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import { createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";
import * as schema from "~/db/schema";

/**
 * Uniqueness the database enforces and `schema.ts` does not declare.
 *
 * Drizzle needs a uniqueness rule only to build an upsert's conflict target,
 * so one it does not know about costs nothing until someone writes that
 * upsert. Each entry is a decision to leave a rule undeclared, not a gap to
 * be filled — but an undeclared rule that is not written down here fails,
 * which is the point: a migration adding one has to be noticed.
 */
const UNDECLARED_UNIQUE: Record<string, string[]> = {
  // 0002. Predates the Drizzle schema's table-level `unique()` helper being
  // used here at all, and no upsert targets it.
  stories: ["project_id+story_id"],
};

/**
 * Columns the database still has and `schema.ts` deliberately does not
 * declare. Drizzle names every declared column in whole-row selects and
 * inserts, and migrations run before the new worker is live, so a column
 * leaves the declaration in one release and the table in a later one.
 * `users.github_plan`: the migration that drops it follows
 * a deploy of the worker that no longer declares it, and removes this entry.
 */
const UNDECLARED_COLUMNS: Record<string, string[]> = {
  users: ["github_plan"],
};

/** Tables SQLite keeps for itself, which no schema declares. */
const INTERNAL_TABLES = /^sqlite_|^__drizzle/;

type Declared = ReturnType<typeof getTableConfig>;

// No type predicate on the filter: each export has its own literal table
// type, and a predicate narrowing to the general `SQLiteTable` is not
// assignable to any of them. The cast goes the other way, which is sound.
const declaredTables: Array<[string, Declared]> = Object.values(schema)
  .filter((value) => value instanceof SQLiteTable)
  .map((table) => {
    const config = getTableConfig(table as SQLiteTable);
    return [config.name, config] as [string, Declared];
  })
  .sort(([a], [b]) => a.localeCompare(b));

let memory: MemoryD1;

beforeAll(() => {
  memory = createMemoryD1();
});

afterAll(() => {
  memory.close();
});

function pragma(sql: string): Array<Record<string, unknown>> {
  return memory.raw.prepare(sql).all() as Array<Record<string, unknown>>;
}

/**
 * Every uniqueness rule the built database enforces, as sorted column groups,
 * with ` (partial)` after a rule that covers only the rows its WHERE admits.
 */
function uniqueGroups(table: string): string[] {
  return pragma(`PRAGMA index_list("${table}")`)
    .filter((index) => index.unique === 1 && index.origin !== "pk")
    .map((index) =>
      pragma(`PRAGMA index_info("${String(index.name)}")`)
        .map((column) => String(column.name))
        .sort()
        .join("+") + (index.partial === 1 ? " (partial)" : ""),
    )
    .sort();
}

/** The unique indexes `schema.ts` declares, in `uniqueGroups`' notation. */
function declaredUniqueIndexes(config: Declared): string[] {
  return config.indexes
    .filter((index) => index.config.unique)
    .map((index) =>
      index.config.columns
        .map((column) => (column as { name: string }).name)
        .sort()
        .join("+") + (index.config.where ? " (partial)" : ""),
    );
}

describe("the Drizzle schema describes the database the migrations build", () => {
  it("declares every table the migrations create, and no others", () => {
    const built = pragma(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
      .map((row) => String(row.name))
      .filter((name) => !INTERNAL_TABLES.test(name));

    expect(declaredTables.map(([name]) => name)).toEqual(built);
  });

  describe.each(declaredTables)("%s", (name, config) => {
    const columns = () => {
      const rows = pragma(`PRAGMA table_info("${name}")`);
      return new Map(rows.map((row) => [String(row.name), row]));
    };

    it("declares every column the table has, and no others", () => {
      const undeclared = UNDECLARED_COLUMNS[name] ?? [];
      // An exception for a column the table no longer has is stale.
      for (const column of undeclared) expect([...columns().keys()]).toContain(column);
      expect(config.columns.map((column) => column.name).sort()).toEqual(
        [...columns().keys()].filter((column) => !undeclared.includes(column)).sort(),
      );
    });

    it("gives each column the type the table gives it", () => {
      const built = columns();
      const declared = Object.fromEntries(
        config.columns
          .filter((column) => built.has(column.name))
          .map((column) => [column.name, column.getSQLType().toUpperCase()]),
      );
      const actual = Object.fromEntries(
        config.columns
          .filter((column) => built.has(column.name))
          .map((column) => [
            column.name,
            String(built.get(column.name)!.type).toUpperCase(),
          ]),
      );
      expect(declared).toEqual(actual);
    });

    it("agrees on which columns may be null", () => {
      // An INTEGER PRIMARY KEY is never null whether or not the DDL says so,
      // and Drizzle expresses that with `.primaryKey()` rather than
      // `.notNull()`. The two notations mean one thing, so both sides are
      // read the same way.
      const built = columns();
      const nullable = (row: Record<string, unknown>) =>
        row.notnull !== 1 && row.pk !== 1;
      const declared = Object.fromEntries(
        config.columns
          .filter((column) => built.has(column.name))
          .map((column) => [column.name, !(column.notNull || column.primary)]),
      );
      const actual = Object.fromEntries(
        config.columns
          .filter((column) => built.has(column.name))
          .map((column) => [column.name, nullable(built.get(column.name)!)]),
      );
      expect(declared).toEqual(actual);
    });

    it("agrees on the primary key", () => {
      const built = columns();
      expect(
        config.columns.filter((column) => column.primary).map((c) => c.name).sort(),
      ).toEqual(
        [...built.values()]
          .filter((row) => row.pk === 1)
          .map((row) => String(row.name))
          .sort(),
      );
    });

    it("declares every uniqueness rule the table enforces", () => {
      const declared = [
        ...config.uniqueConstraints.map((constraint) =>
          constraint.columns.map((column) => column.name).sort().join("+"),
        ),
        ...config.columns.filter((column) => column.isUnique).map((c) => c.name),
        ...declaredUniqueIndexes(config),
        ...(UNDECLARED_UNIQUE[name] ?? []),
      ].sort();

      expect(declared).toEqual(uniqueGroups(name));
    });
  });
});
