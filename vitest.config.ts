import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // Mirror vite.config.ts `define` so consumers of __BUILD_SHA__ work in tests.
  define: {
    __BUILD_SHA__: JSON.stringify(process.env.BUILD_SHA ?? "dev"),
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./app"),
    },
    // Prefer TypeScript sources over any stray compiled .js artefacts that
    // may linger beside .ts/.tsx files in the app tree.
    extensions: [".ts", ".tsx", ".mjs", ".mts", ".js", ".jsx", ".json"],
  },
});
