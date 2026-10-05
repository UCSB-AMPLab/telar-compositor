/**
 * Types for the `workers` Vitest project.
 *
 * `@cloudflare/vitest-plugin` 1.1.4 types `env` from `cloudflare:workers` as
 * `Cloudflare.Env`, an empty interface that a project widens by declaration
 * merging. This file merges the compositor's own `Env` into it — the bindings
 * `wrangler.jsonc` and the pool's `miniflare.bindings` supply — and adds
 * `TEST_MIGRATIONS`, which exists only under test.
 *
 * The alias is needed because a bare `Env` inside `namespace Cloudflare`
 * resolves to the interface being declared, not to the global one.
 *
 * @version v1.5.0-beta
 */

/// <reference types="@cloudflare/vitest-plugin/types" />

type CompositorWorkerEnv = Env;

declare namespace Cloudflare {
  interface Env extends CompositorWorkerEnv {
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
