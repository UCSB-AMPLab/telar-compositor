/**
 * Setup for the `workers` Vitest project.
 *
 * The real migration chain, read at configuration time into `TEST_MIGRATIONS`,
 * is what builds the schema the Durable Object reads and writes: a hand-written
 * subset would let a test pass against a table shape production does not have.
 * `applyD1Migrations` records what it has applied and skips the rest, so files
 * sharing one database pay for the chain once.
 *
 * `tests/setup.ts` is deliberately not loaded here: it installs Testing Library
 * and jsdom matchers, neither of which exists inside workerd.
 *
 * @version v1.5.0-beta
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
