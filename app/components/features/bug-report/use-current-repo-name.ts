/**
 * This file is the bug-report panel's read of the name GitHub currently gives
 * the displayed project's repository, from `/api/repo-identity`.
 *
 * The request names the displayed project, because the session's active
 * project can be another one when a second tab has switched it; an answer
 * that names any other project is dropped. The answer is used only when it
 * differs from the name the panel already holds. Anything short of a prompt,
 * well-formed answer for this project — a failed request, an error status, a
 * null name, or no answer within the timeout — is null, and the panel opens
 * and submits without it.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useState } from "react";

/** How long the panel waits for GitHub before leaving the row out. */
export const REPO_NAME_TIMEOUT_MS = 4000;

export async function readCurrentRepoName(
  projectId: number,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(`/api/repo-identity?projectId=${projectId}`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { projectId?: unknown; fullName?: unknown };
    if (body.projectId !== projectId) return null;
    return typeof body.fullName === "string" ? body.fullName : null;
  } catch {
    return null;
  }
}

/**
 * The repository's current name while the panel is open, when it differs from
 * `storedName`; undefined otherwise. Nothing is asked without a project and a
 * stored name.
 */
export function useCurrentRepoName(
  open: boolean,
  projectId: number | undefined,
  storedName: string | undefined,
): string | undefined {
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    setCurrent(null);
    if (!open || projectId === undefined || !storedName) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPO_NAME_TIMEOUT_MS);
    readCurrentRepoName(projectId, controller.signal).then((name) => {
      if (!controller.signal.aborted) setCurrent(name);
    });
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, projectId, storedName]);

  return current && current !== storedName ? current : undefined;
}
