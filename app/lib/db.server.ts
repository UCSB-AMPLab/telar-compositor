import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";

/**
 * Returns a typed Drizzle instance backed by the given D1 binding.
 * Call this inside loaders, actions, and middleware — never at module level.
 */
export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
