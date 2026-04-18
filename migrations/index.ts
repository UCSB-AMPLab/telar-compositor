/**
 * Bundled historical migration manifests.
 *
 * Hand-authored JSON manifests for historical Telar versions are imported here
 * and exposed as BUNDLED_MANIFESTS. Future versions (v1.2.0+) arrive as
 * release assets on the framework repo and are loaded via fetchReleaseManifest.
 *
 * Bundled is the canonical historical set.
 * Future manifests load from GitHub release assets.
 */

import v092_to_v093 from "./v0.9.2-beta-to-v0.9.3-beta.json";
import v093_to_v094 from "./v0.9.3-beta-to-v0.9.4-beta.json";
import v094_to_v100 from "./v0.9.4-beta-to-v1.0.0-beta.json";
import v100_to_v110 from "./v1.0.0-beta-to-v1.1.0.json";
import v110_to_v120 from "./v1.1.0-to-v1.2.0.json";
import { validateManifest, type Manifest } from "~/lib/manifest-schema.server";

/**
 * Historical manifests bundled with the compositor. Ordered by from_version
 * so consumers can iterate the chain in application order.
 */
export const BUNDLED_MANIFESTS: Manifest[] = [
  v092_to_v093 as Manifest,
  v093_to_v094 as Manifest,
  v094_to_v100 as Manifest,
  v100_to_v110 as Manifest,
  v110_to_v120 as Manifest,
];

/**
 * Runs validateManifest on every bundled manifest. Called from tests to catch
 * hand-authoring errors at CI time rather than upgrade time. Throws on the
 * first invalid entry with the manifest's from→to versions for easy diagnosis.
 */
export function validateBundledManifests(): void {
  for (let i = 0; i < BUNDLED_MANIFESTS.length; i++) {
    const m = BUNDLED_MANIFESTS[i];
    try {
      validateManifest(m);
    } catch (err) {
      throw new Error(
        `Bundled manifest at index ${i} (${m.from_version} → ${m.to_version}) failed validation: ${(err as Error).message}`,
      );
    }
  }
}
