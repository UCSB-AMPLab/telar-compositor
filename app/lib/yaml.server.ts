/**
 * Thin wrapper around js-yaml for use in Cloudflare Workers runtime.
 *
 * Only the `load` function is imported to keep bundle size minimal (~40KB
 * vs the full js-yaml package). Call this from server-only modules (.server.ts)
 * — never import into client bundles.
 */

import { load } from "js-yaml";

/**
 * Parses a YAML string and returns the result as a plain object.
 *
 * Uses js-yaml's safe `load` which handles all standard YAML features
 * including multiline strings, anchors, and type coercion. Throws if
 * the input is not valid YAML.
 */
export function parseYaml(yamlString: string): Record<string, unknown> {
  return load(yamlString) as Record<string, unknown>;
}
