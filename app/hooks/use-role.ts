/**
 * Typed loader-read hooks for the current user's project role.
 *
 * useRole() reads `userRole` from the routes/_app loader (the single server-
 * computed source of truth, derived from D1 membership) and returns it as a
 * narrowed union. useIsConvenor() collapses that to a boolean. Together they
 * replace the ad-hoc `useRouteLoaderData("routes/_app") as { userRole?: string }`
 * casts that role-gated routes would otherwise repeat.
 *
 * UX layer only — NOT a security boundary. Hiding affordances by role is a
 * convenience; the real gate stays the server action (requireOwner / userRole
 * checks), where role enforcement actually lives.
 *
 * @version v1.3.0-beta
 */

import { useRouteLoaderData } from "react-router";

type AppLoaderRole = { userRole?: "convenor" | "collaborator" | null };

/**
 * The current user's project role, or null when unknown (no project, or the
 * loader did not supply userRole).
 */
export function useRole(): "convenor" | "collaborator" | null {
  const app = useRouteLoaderData("routes/_app") as AppLoaderRole | null;
  return app?.userRole ?? null;
}

/** True only when the current user is the project convenor. */
export function useIsConvenor(): boolean {
  return useRole() === "convenor";
}
