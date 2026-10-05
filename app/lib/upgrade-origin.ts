/**
 * Where a person was going when they were sent to /upgrade.
 *
 * `/upgrade?from=` is written by the Publish gate, by the Upload tab's
 * upgrade link and by onboarding after an import, and it is read twice: to
 * say what the upgrade stands between the person and, and to send them on
 * when there turns out to be nothing to upgrade. Both readings go through
 * this one parser, and both answer with a fixed path from the table below,
 * never the query value itself — which is user-controlled, and which
 * `redirect()` would otherwise forward to any origin it names.
 *
 * @version v1.5.0-beta
 */

export type UpgradeOrigin = "publish" | "objects" | "config";

const ORIGIN_PATHS: Record<UpgradeOrigin, string> = {
  publish: "/publish",
  objects: "/objects",
  config: "/config",
};

/**
 * The origin a `from` value names, matching a path exactly or as a parent
 * (`/objects/abc` is Objects; `/publishing` is nothing).
 */
export function readUpgradeOrigin(from: string | null): UpgradeOrigin | null {
  if (!from) return null;
  for (const origin of Object.keys(ORIGIN_PATHS) as UpgradeOrigin[]) {
    const path = ORIGIN_PATHS[origin];
    if (from === path || from.startsWith(`${path}/`)) return origin;
  }
  return null;
}

/** The path an origin returns to. */
export function upgradeOriginPath(origin: UpgradeOrigin): string {
  return ORIGIN_PATHS[origin];
}

/** Where to send someone whose site needs no upgrade: back, or to Objects. */
export function upgradeReturnPath(from: string | null): string {
  const origin = readUpgradeOrigin(from);
  return origin ? ORIGIN_PATHS[origin] : "/objects";
}

const GATE_REASON_KEYS: Record<UpgradeOrigin, string> = {
  publish: "gateReason_publish",
  objects: "gateReason_upload",
  config: "gateReason_import",
};

/**
 * The sentence that says why a person is on /upgrade, or null.
 *
 * Only while the upgrade is still to be done: `needsUpgrade` is loader data
 * and the loader is held for the whole flow, so past the review stage it
 * would go on asking for an upgrade beside one that has finished. Only when
 * the loader established it: its GitHub-error fallback reports
 * `needsUpgrade: false`, and a reason stated there would be unverified.
 */
export function gateReasonKey(
  origin: UpgradeOrigin | null,
  stage: string,
  needsUpgrade: boolean,
): string | null {
  if (!origin || stage !== "review" || !needsUpgrade) return null;
  return GATE_REASON_KEYS[origin];
}

