/**
 * The registration of committed objects answers a failure rather than
 * throwing. Its callers run after a commit has landed, where a throw
 * would report the commit as failed and skip the rest of the action.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";

import { registerCommittedObjects } from "~/lib/register-objects.server";

describe("registerCommittedObjects", () => {
  it("answers insert_failed when the collaboration object cannot be reached at all", async () => {
    const env = {
      SESSION_SECRET: "secret",
      COLLABORATION: {
        idFromName: () => "id",
        get: () => {
          throw new Error("namespace unavailable");
        },
      },
    } as unknown as Env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await registerCommittedObjects(env, {} as never, 42, 7, [
      { object_id: "a-title", title: "A Title", featured: false, image_available: false } as never,
    ]);
    errors.mockRestore();
    expect(result).toMatchObject({ ok: false, error: "insert_failed" });
  });
});
