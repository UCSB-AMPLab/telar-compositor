/**
 * An in-memory D1 binding for tests, backed by `node:sqlite` and built by
 * replaying the repository's own migration chain.
 *
 * The join-code module's contract is largely about SQL the ORM emits —
 * the atomic parent compare-and-set, cap accounting over
 * `joined_via_invite_id`, the `used_at` consumed flag, UNIQUE-collision
 * regeneration. A hand-written drizzle spy can assert the shape of those
 * statements but not their effect, so these tests run the real Drizzle
 * client against a real SQLite file held in memory.
 *
 * The schema is the migrations, not a hand-copied DDL: `app/db/migrations`
 * is replayed in filename order, so a migration that diverges from
 * `schema.ts` surfaces here as a failing query rather than as a passing
 * test against a stale copy.
 *
 * Only the surface Drizzle's D1 driver and the application code touch is
 * implemented: `prepare().bind().{all,raw,run,first}`, `batch`, `exec`.
 * `raw()` reads values off the row object in insertion order, which is the
 * select order — a query selecting two columns of the same name would
 * collide, so joins that alias duplicate names are outside this shim.
 *
 * @version v1.5.0-beta
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "app",
  "db",
  "migrations",
);

type SqlParam = null | number | string | Uint8Array;

// D1 refuses `undefined`, a bigint, a Date and any other object that is not
// bytes, with this error, and throws it from `bind()`. The fake refuses the same
// values at the same point: coercing them here would pass a test on a statement
// production rejects. `tests/helpers/d1-bind-cases.ts` holds the cases both
// harnesses check.
function typeError(p: unknown): Error {
  return new Error(`D1_TYPE_ERROR: Type '${typeof p}' not supported for value '${String(p)}'`);
}

function normalise(params: unknown[]): SqlParam[] {
  return params.map((p) => {
    if (p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "string") return p;
    // D1 carries values as JSON, where a non-finite number becomes null.
    if (typeof p === "number") return Number.isFinite(p) ? p : null;
    // D1 copies the bytes when binding; a caller that later reuses the buffer
    // does not change what is written. node:sqlite would bind an ArrayBuffer as
    // NULL.
    if (p instanceof Uint8Array) return new Uint8Array(p);
    if (p instanceof ArrayBuffer) return new Uint8Array(p.slice(0));
    throw typeError(p);
  });
}

// How many values a statement takes, counted as SQLite counts them, outside
// string literals, quoted identifiers and comments: `?NNN` takes index NNN; a
// bare `?`, and a `:name`, `@name` or `$name` seen for the first time, take one
// more than the largest index so far; the count is the largest index. D1 refuses
// a statement bound with any other number; node:sqlite binds a missing value as
// NULL.
function parameterCount(sql: string): number {
  let count = 0;
  const names = new Map<string, number>();
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = sql.indexOf(c, i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "?") {
      const digits = /^\d+/.exec(sql.slice(i + 1))?.[0];
      count = Math.max(count, digits === undefined ? count + 1 : Number(digits));
      i += 1 + (digits?.length ?? 0);
    } else if ((c === ":" || c === "@" || c === "$") && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      const name = /^[A-Za-z_]\w*/.exec(sql.slice(i + 1))![0];
      if (!names.has(c + name)) names.set(c + name, (count += 1));
      i += 1 + name.length;
    } else {
      i += 1;
    }
  }
  return count;
}

// A hand-written D1 stub (`prepare: () => ({ bind: () => ({...}) })`) validates
// nothing on its own, so a test built on one cannot catch code binding a value
// or count real D1 refuses. This runs the same checks `MemoryStatement.bind`
// and `checkCount` run, for a stub to call from its own `bind`. Real D1 throws
// the type error synchronously from `bind()` and the count error only at
// execution (`run`/`all`/`first`); a stub that has no execution step of its own
// throws both from `bind`, which is a stub constraint, not a behaviour claim
// about D1. `sql` is checked for parameter count only when the stub has it in
// scope — pass `undefined` where it does not, which skips that check.
export function checkD1Bind(sql: string | undefined, params: unknown[]): void {
  normalise(params);
  if (sql !== undefined && params.length !== parameterCount(sql)) {
    throw new Error("D1_ERROR: Wrong number of parameter bindings for SQL query.");
  }
}

function meta(changes: number, lastRowId: number) {
  return {
    changes,
    last_row_id: lastRowId,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
    size_after: 0,
    changed_db: changes > 0,
  };
}

class MemoryStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SqlParam[] = [],
  ) {}

  // D1 checks the values in `bind()` itself and throws there, before anything
  // runs, so a batch holding one bad statement is never sent.
  bind(...params: unknown[]) {
    return new MemoryStatement(this.db, this.sql, normalise(params));
  }

  private checkCount() {
    if (this.params.length !== parameterCount(this.sql)) {
      throw new Error("D1_ERROR: Wrong number of parameter bindings for SQL query.");
    }
  }

  private rows(): Array<Record<string, unknown>> {
    this.checkCount();
    const stmt = this.db.prepare(this.sql);
    return stmt.all(...this.params) as Array<Record<string, unknown>>;
  }

  async all() {
    const results = this.rows();
    return { success: true, results, meta: meta(0, 0) };
  }

  async raw() {
    return this.rows().map((row) => Object.values(row));
  }

  async first(column?: string) {
    const row = this.rows()[0];
    if (row === undefined) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async run() {
    this.checkCount();
    const stmt = this.db.prepare(this.sql);
    // D1 answers a statement with a RETURNING clause with its rows even
    // through `run()` — which is how a batch runs every statement — and
    // drizzle maps a batched `.returning()` from those rows. Reporting none
    // would make every such statement look as though it touched nothing.
    if (/\breturning\b/i.test(this.sql)) {
      const results = stmt.all(...this.params) as Array<Record<string, unknown>>;
      return { success: true, results, meta: meta(results.length, 0) };
    }
    const result = stmt.run(...this.params);
    return {
      success: true,
      results: [],
      meta: meta(Number(result.changes), Number(result.lastInsertRowid)),
    };
  }
}

export interface MemoryD1 {
  prepare(sql: string): MemoryStatement;
  batch(statements: MemoryStatement[]): Promise<unknown[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  /** Escape hatch for assertions that read state the ORM would hide. */
  raw: DatabaseSync;
  close(): void;
}

/** A fresh database with every migration in `app/db/migrations` applied. */
export function createMemoryD1(): MemoryD1 {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
  }
  // Deferred FK enforcement mirrors D1: the rebuild migrations rely on it,
  // and the application's own inserts must satisfy the references.
  db.exec("PRAGMA foreign_keys = ON");

  return {
    prepare: (sql: string) => new MemoryStatement(db, sql),
    // One transaction, because that is what D1 gives a batch: the sequence
    // rolls back on the first failing statement, so a caller can never observe
    // a half-applied batch, and a statement whose trigger aborts takes every
    // statement beside it with it. Run one at a time and untransacted, this
    // shim would leave a state D1 cannot produce.
    //
    // The COMMIT is inside the protected body, not after it: a deferred
    // constraint fails at the commit and nowhere else, and a commit that throws
    // outside the guard would leave the transaction open, the uncommitted rows
    // readable, and the next batch unable to begin one.
    batch: async (statements: MemoryStatement[]) => {
      const out: unknown[] = [];
      db.exec("BEGIN");
      try {
        for (const statement of statements) out.push(await statement.run());
        db.exec("COMMIT");
      } catch (err) {
        // The original error is what the caller reconciles against, so the
        // rollback may not replace it; a commit that already unwound the
        // transaction leaves nothing to roll back.
        try { db.exec("ROLLBACK"); } catch { /* no transaction is active */ }
        throw err;
      }
      return out;
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    raw: db,
    close: () => db.close(),
  };
}

/**
 * Drop migration 0071's index, for a case that needs two rows under one
 * object_id: a database from before that migration is the only one that can
 * hold them.
 */
export function beforeObjectIdentityIndex(memory: MemoryD1): void {
  memory.raw.exec("DROP INDEX objects_project_object_unique");
}

/** The D1 binding type the application expects, satisfied by the shim. */
export function asD1(memory: MemoryD1): D1Database {
  return memory as unknown as D1Database;
}
