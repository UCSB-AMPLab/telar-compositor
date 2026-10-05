/**
 * What D1's `.bind()` accepts, as one set of assertions run by two harnesses.
 *
 * The workers project runs them against the real D1 binding inside workerd
 * (`tests/workers/d1-bind-types.test.ts`); the unit project runs them against
 * the in-memory fake (`tests/d1-memory-bind-parity.test.ts`). A value or
 * statement D1 refuses has to be refused by the fake too: a fake that coerces it
 * lets a test pass on a statement production aborts. Because both files run this one function, a case cannot be checked
 * against one harness and not the other.
 *
 * Only cases both harnesses agree on are listed. D1 also accepts an array,
 * storing it as a blob, and a named parameter (`:a`) bound by position; the
 * fake refuses both, which can only fail a test that production would pass,
 * never the reverse.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll } from "vitest";

interface BindCase {
  label: string;
  value: () => unknown;
  /** false: `bind()` itself throws D1_TYPE_ERROR. */
  accepted: boolean;
}

const BIND_CASES: BindCase[] = [
  { label: "null", value: () => null, accepted: true },
  { label: "a string", value: () => "s", accepted: true },
  { label: "a number", value: () => 1.5, accepted: true },
  { label: "a boolean", value: () => true, accepted: true },
  { label: "a Uint8Array", value: () => new Uint8Array([1, 2]), accepted: true },
  { label: "an ArrayBuffer", value: () => new Uint8Array([1, 2]).buffer, accepted: true },
  { label: "undefined", value: () => undefined, accepted: false },
  { label: "a bigint", value: () => 12n, accepted: false },
  { label: "a Date", value: () => new Date(0), accepted: false },
  { label: "a plain object", value: () => ({ a: 1 }), accepted: false },
];

/** Numbers D1 accepts and stores as NULL. */
const NULL_NUMBERS = [NaN, Infinity, -Infinity];

interface CountCase {
  label: string;
  sql: string;
  /** null runs the statement without calling `bind()`. */
  params: unknown[] | null;
  /** false: running the statement fails with "Wrong number of parameter bindings". */
  accepted: boolean;
}

const COUNT_CASES: CountCase[] = [
  { label: "a parameter never bound", sql: "SELECT ? AS a", params: null, accepted: false },
  { label: "too few values", sql: "SELECT ? AS a, ? AS b", params: [1], accepted: false },
  { label: "too many values", sql: "SELECT ? AS a", params: [1, 2], accepted: false },
  { label: "a question mark inside a literal", sql: "SELECT '?' AS a", params: null, accepted: true },
  { label: "a numbered parameter used twice", sql: "SELECT ?1 AS a, ?1 AS b", params: [5], accepted: true },
  { label: "one value per parameter", sql: "SELECT ? AS a, ? AS b", params: [1, 2], accepted: true },
  { label: "a bare parameter after a higher numbered one", sql: "SELECT ?2 AS a, ?1 AS b, ? AS c", params: [1, 2], accepted: false },
  { label: "a bare parameter numbered past ?2", sql: "SELECT ?2 AS a, ?1 AS b, ? AS c", params: [1, 2, 3], accepted: true },
  { label: "a named parameter never bound", sql: "SELECT :a AS a", params: null, accepted: false },
];

const TABLE = "bind_probe";

export function describeD1Binds(harness: string, db: () => D1Database) {
  describe(`${harness}: bind`, () => {
    beforeAll(async () => {
      await db().exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (v)`);
    });

    const insert = (value: unknown) =>
      db().prepare(`INSERT INTO ${TABLE} (v) VALUES (?)`).bind(value);

    it.each(BIND_CASES)("$label: accepted is $accepted", async ({ value, accepted }) => {
      if (accepted) await expect(insert(value()).run()).resolves.toMatchObject({ success: true });
      else expect(() => insert(value())).toThrow(/D1_TYPE_ERROR: /);
    });

    it("a refused value stops the batch before any statement runs", async () => {
      const marker = `batch-${crypto.randomUUID()}`;

      expect(() => db().batch([insert(marker), insert(undefined)])).toThrow(
        /D1_TYPE_ERROR: Type 'undefined'/,
      );
      const row = await db().prepare(`SELECT count(*) AS n FROM ${TABLE} WHERE v = ?`)
        .bind(marker).first();
      expect(row).toEqual({ n: 0 });
    });

    it.each(NULL_NUMBERS)("%s is stored as NULL", async (value) => {
      const row = await db().prepare("SELECT typeof(?) AS t").bind(value).first();
      expect(row).toEqual({ t: "null" });
    });

    it.each([
      ["a Uint8Array", (b: Uint8Array) => b],
      ["an ArrayBuffer", (b: Uint8Array) => b.buffer],
    ] as const)("%s's bytes are copied when bound", async (_label, wrap) => {
      const bytes = new Uint8Array([1, 2]);
      const statement = db().prepare("SELECT typeof(?1) AS t, hex(?1) AS h").bind(wrap(bytes));
      bytes[0] = 9;

      expect(await statement.first()).toEqual({ t: "blob", h: "0102" });
    });

    it.each(COUNT_CASES)("$label: accepted is $accepted", async ({ sql, params, accepted }) => {
      const prepared = db().prepare(sql);
      const statement = params === null ? prepared : prepared.bind(...params);

      if (accepted) await expect(statement.first()).resolves.not.toBeNull();
      else await expect(statement.first()).rejects.toThrow(/Wrong number of parameter bindings/);
    });
  });
}
