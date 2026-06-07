/**
 * Re-export shim — the canonical ProjectSwitcher lives in
 * `app/components/features/header/ProjectSwitcher.tsx`, where feature
 * components belong. Some callers import it from this layout path, so this
 * shim keeps that import path stable while the implementation stays in
 * features/header/.
 *
 * @version v1.3.0-beta
 */

export {
  ProjectSwitcher,
  type ProjectSwitcherProps,
  type ProjectSwitcherProject,
} from "~/components/features/header/ProjectSwitcher";
