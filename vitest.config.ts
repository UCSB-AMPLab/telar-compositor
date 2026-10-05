/**
 * Root Vitest configuration: two projects, one command.
 *
 * `unit` is the suite that runs in Node — jsdom matchers, Testing Library, the
 * fakes around the Durable Object. `workers` runs inside workerd through
 * `@cloudflare/vitest-plugin`, which is the only harness that can evict a
 * Durable Object at a chosen point and leave its hibernated sockets attached.
 * The two share nothing at runtime: `tests/setup.ts` loads jsdom matchers, which
 * have no meaning inside workerd, so the workers project has a setup file of its
 * own and `tests/workers/**` is excluded from the unit project's `include`.
 *
 * Project configs do not inherit the root `resolve` and `define`, so the `~`
 * alias, the resolve extensions and `__BUILD_SHA__` are restated in each:
 * `workers/collaboration.ts` and its imports reach the app tree through `~/`.
 *
 * `main` for the workers project is `tests/workers/entry.ts`, not the
 * `workers/app.ts` that the root `wrangler.jsonc` names: that file imports
 * `virtual:react-router/server-build`, which exists only inside the app's Vite
 * build. The plugin still reads a Wrangler config, for the D1 and Durable
 * Object bindings, the `v1` migration that declares the class, the
 * compatibility date and `nodejs_compat` — but it is pointed at
 * `tests/workers/wrangler.jsonc`, not the root config: the plugin resolves
 * dev vars from whatever `.dev.vars` file sits beside the config path it is
 * given, so the root config would load the developer's real secrets ahead of
 * the test bindings below. `tests/workers/` has no `.dev.vars`, so this project
 * only ever sees the literal test values `miniflare.bindings` supplies.
 *
 * @version v1.5.0-beta
 */

import { resolve } from "path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const appDir = resolve(__dirname, "./app");
const migrationsDir = resolve(__dirname, "./app/db/migrations");

// Mirror vite.config.ts `define` so consumers of __BUILD_SHA__ work in tests.
const defines = {
  __BUILD_SHA__: JSON.stringify(process.env.BUILD_SHA ?? "dev"),
};

const resolveOptions = {
  alias: {
    "~": appDir,
  },
  // Prefer TypeScript sources over any stray compiled .js artefacts that
  // may linger beside .ts/.tsx files in the app tree.
  extensions: [".ts", ".tsx", ".mjs", ".mts", ".js", ".jsx", ".json"],
};

export default defineConfig({
  test: {
    // A run fails when a file it planned, or one the include globs list,
    // reports no result; the summary line alone cannot show a dropped file.
    // A `--reporter` flag on the command line replaces this list and turns
    // the check off.
    reporters: ["default", "./tests/helpers/complete-run-reporter.ts"],
    projects: [
      {
        define: defines,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: ["**/node_modules/**", "tests/workers/**"],
          setupFiles: ["tests/setup.ts"],
          // Vitest refuses to group projects that differ in `maxWorkers` under
          // one `groupOrder`; the two run in sequence, unit first.
          sequence: { groupOrder: 0 },
        },
        resolve: resolveOptions,
      },
      {
        define: defines,
        plugins: [
          cloudflareTest(async () => ({
            main: "./tests/workers/entry.ts",
            wrangler: { configPath: "./tests/workers/wrangler.jsonc" },
            miniflare: {
              bindings: {
                // The real migration chain, applied to an empty database by
                // tests/workers/setup.ts.
                TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
                // Test values, chosen here and nowhere else. SESSION_SECRET is
                // what the socket tests sign their session tokens with;
                // ENCRYPTION_KEY has to be 32 bytes of hex to be a usable
                // AES-256 key.
                SESSION_SECRET: "test-session-secret",
                ENCRYPTION_KEY: "0".repeat(64),
                GITHUB_CLIENT_ID: "test-client-id",
                GITHUB_CLIENT_SECRET: "test-client-secret",
                GITHUB_CALLBACK_URL: "http://localhost/auth/callback",
                GITHUB_APP_ID: "1",
                GITHUB_PRIVATE_KEY: "test-private-key",
              },
            },
          })),
        ],
        test: {
          name: "workers",
          include: ["tests/workers/**/*.test.ts"],
          setupFiles: ["tests/workers/setup.ts"],
          // Durable Object storage is shared across this project's files, so
          // every test mints fixture ids of its own rather than depending on a
          // fresh database. One worker keeps the sharing predictable.
          maxWorkers: 1,
          isolate: false,
          sequence: { groupOrder: 1 },
        },
        resolve: resolveOptions,
      },
    ],
  },
});
