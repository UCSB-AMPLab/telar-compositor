/**
 * Re-export shim — the canonical ProjectSwitcher lives in
 * `app/components/features/header/ProjectSwitcher.tsx`, where feature
 * components belong. The one production consumer (Header.tsx) imports
 * directly from that features/header/ path; this shim exists only to keep
 * `tests/ProjectSwitcher.test.tsx` (the sole importer of this layout path)
 * working without a rewrite.
 *
 * @version v1.4.0-beta
 */

export {
  ProjectSwitcher,
  type ProjectSwitcherProps,
  type ProjectSwitcherProject,
} from "~/components/features/header/ProjectSwitcher";
