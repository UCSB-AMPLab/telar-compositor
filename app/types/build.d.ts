/**
 * This file declares the build-time globals that Vite's `define` config
 * injects into the bundle, so TypeScript knows about them at compile
 * time.
 *
 * `__BUILD_SHA__` is replaced at bundle time with a JSON.stringify-wrapped
 * git short SHA (set by the `build` script's inline `BUILD_SHA=…` env var)
 * or the literal string "dev" outside a build. See vite.config.ts.
 *
 * @version v1.2.0-beta
 */

declare const __BUILD_SHA__: string;
