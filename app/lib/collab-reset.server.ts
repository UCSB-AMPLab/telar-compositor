/**
 * Read a project's saving state from its collaboration Durable Object.
 *
 * The halted-project restore (`api.persistence.tsx`) reads the state here
 * before it sends its own signed reset. Config repairs no longer reset the
 * document: they go through it (`config-repair.server.ts`).
 *
 * @version v1.5.0-beta
 */

import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";

interface CollabResetEnv {
  SESSION_SECRET: string;
  COLLABORATION: {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
  };
}

/** What `/persistence-state` answers, passed through for a caller that reports it. */
export interface PersistenceStateAnswer {
  projectId: number;
  halted: boolean | null;
  reason?: string;
  at?: number;
  generation?: number;
  /** The object's non-2xx body, present only when `halted` is null. */
  unavailable?: string;
}

function collaborationStubFor(env: CollabResetEnv, projectId: number) {
  return env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
}

/**
 * Read one project's saving state through the object's read-only route.
 *
 * A non-2xx status is not an error here: the object is saying it cannot
 * answer, and the answer comes back with `halted: null` rather than throwing,
 * so a caller decides for itself whether that unreadable state blocks it.
 */
export async function readPersistenceState(
  env: CollabResetEnv,
  projectId: number,
): Promise<PersistenceStateAnswer> {
  const headers = await makeInternalMarkerHeaders(
    projectId,
    env.SESSION_SECRET,
    "persistence-state",
  );
  const response = await collaborationStubFor(env, projectId).fetch(
    new Request("https://internal/persistence-state", { method: "GET", headers }),
  );
  if (!response.ok) {
    return { projectId, halted: null, unavailable: await response.text() };
  }
  const body = (await response.json()) as {
    halted: boolean;
    reason?: string;
    at?: number;
    generation: number;
  };
  return {
    projectId,
    halted: body.halted,
    reason: body.reason,
    at: body.at,
    generation: body.generation,
  };
}
