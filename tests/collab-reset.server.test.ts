/**
 * Pins resetCollabDocIfBlobExists — the coordination that keeps a request-side
 * project_config repair (onboarding's fix-site-config) from being clobbered by a
 * stale collaboration Y.Doc.
 *
 * fix-site-config writes url/baseurl/google_sheets_enabled straight to D1, but
 * those columns round-trip through the DO snapshot. If the project already has a
 * yjs_state blob (the editor has been opened), a warm/blob-restored DO holds the
 * OLD config Y.Map and its next snapshot would overwrite the repair. Calling the
 * DO /reset rebuilds the Y.Doc from the repaired D1. When no blob exists (the
 * normal first-onboarding case) there is nothing to clobber, so we skip the call
 * and avoid needlessly spinning up the DO.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const blobRows: Array<{ yjs_state: ArrayBuffer | null }> = [];

vi.mock("~/db/schema", () => ({ projects: { id: "id", yjs_state: "yjs_state" } }));

function makeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => blobRows),
        })),
      })),
    })),
  };
}

function makeEnv() {
  const fetch = vi.fn(async (_req: Request) => new Response("OK", { status: 200 }));
  const stub = { fetch };
  return {
    env: {
      SESSION_SECRET: "test-secret",
      COLLABORATION: {
        idFromName: vi.fn((s: string) => `do-${s}`),
        get: vi.fn(() => stub),
      },
    },
    fetch,
  };
}

import { resetCollabDocIfBlobExists } from "~/lib/collab-reset.server";

beforeEach(() => {
  blobRows.length = 0;
});

describe("resetCollabDocIfBlobExists", () => {
  it("calls the DO /reset (with internal-marker headers) when a yjs_state blob exists", async () => {
    blobRows.push({ yjs_state: new Uint8Array([1, 2, 3]).buffer });
    const db = makeDb();
    const { env, fetch } = makeEnv();

    await resetCollabDocIfBlobExists(db as never, env as never, 42);

    expect(env.COLLABORATION.idFromName).toHaveBeenCalledWith("42");
    expect(fetch).toHaveBeenCalledTimes(1);
    const req = fetch.mock.calls[0][0] as Request;
    expect(req.url).toMatch(/\/reset$/);
    expect(req.method).toBe("POST");
    expect(req.headers.get("X-Internal-Project")).toBe("42");
    expect(req.headers.get("X-Internal-Auth")).toBeTruthy();
  });

  it("does NOT call the DO when there is no blob (cold start will use repaired D1)", async () => {
    blobRows.push({ yjs_state: null });
    const db = makeDb();
    const { env, fetch } = makeEnv();

    await resetCollabDocIfBlobExists(db as never, env as never, 42);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("is best-effort: a DO fetch failure does not throw", async () => {
    blobRows.push({ yjs_state: new Uint8Array([1]).buffer });
    const db = makeDb();
    const { env } = makeEnv();
    (env.COLLABORATION.get as ReturnType<typeof vi.fn>).mockReturnValue({
      fetch: vi.fn(async () => {
        throw new Error("DO unreachable");
      }),
    });

    await expect(resetCollabDocIfBlobExists(db as never, env as never, 42)).resolves.toBeUndefined();
  });
});
