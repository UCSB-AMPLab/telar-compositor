/**
 * A registration carries its operation's id to the ingest, and reads an
 * ingest that had already applied that id as the success it is.
 * A failure says whether sending it again can help, so a completion never
 * waits on one that cannot.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { registerCommittedObjects } from "~/lib/register-objects.server";
import type { PendingObject } from "~/lib/sync.server";

function pending(objectId: string): PendingObject {
  return {
    object_id: objectId, title: objectId, featured: false, creator: null, description: null,
    source_url: null, period: null, year: null, object_type: null, subjects: null, source: null,
    credit: null, thumbnail: null, image_available: false,
  };
}

function makeEnv(answer: () => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  const env = {
    SESSION_SECRET: "s",
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          bodies.push(JSON.parse(await req.text()));
          return answer();
        },
      }),
    },
  } as unknown as Env;
  return { env, bodies };
}

const db = {} as never;

describe("registerCommittedObjects with an operation id", () => {
  it("sends the id as the ingest's opId", async () => {
    const { env, bodies } = makeEnv(() => Response.json({ applied: { objectInsert: 1 } }));
    await registerCommittedObjects(env, db, 42, 7, [pending("bell")], { opId: 12 });
    expect(bodies[0].opId).toBe(12);
  });

  it("sends no opId without one, as every existing caller does", async () => {
    const { env, bodies } = makeEnv(() => Response.json({ applied: { objectInsert: 1 } }));
    await registerCommittedObjects(env, db, 42, 7, [pending("bell")]);
    expect(bodies[0]).not.toHaveProperty("opId");
  });

  it("reads already applied as success", async () => {
    const { env } = makeEnv(() => Response.json({ alreadyApplied: true }));
    const result = await registerCommittedObjects(env, db, 42, 7, [pending("bell")], { opId: 12 });
    expect(result).toMatchObject({ ok: true, alreadyApplied: true });
  });

  it("attributes the objects to a null actor when the record names none", async () => {
    const { env, bodies } = makeEnv(() => Response.json({ applied: { objectInsert: 1 } }));
    await registerCommittedObjects(env, db, 42, null, [pending("bell")], { opId: 12 });
    const inserts = (bodies[0].objects as { insert: Array<{ created_by: unknown }> }).insert;
    expect(inserts[0].created_by).toBeNull();
  });
});

describe("whether a failed registration is worth sending again", () => {
  it.each([
    ["an ingest that answers 503", () => new Response("x", { status: 503 }), true],
    ["an insert D1 refused", () => Response.json({ failed: { objectInsert: ["bell"] } }), true],
    ["an object_id the DO refused", () => Response.json({ refused: { objectInsert: [0] } }), false],
  ] as const)("%s", async (_name, answer, retryable) => {
    const { env } = makeEnv(answer);
    const result = await registerCommittedObjects(env, db, 42, 7, [pending("bell")], { opId: 1 });
    expect(result).toMatchObject({ ok: false, retryable });
  });

  it("an unreachable ingest is worth sending again", async () => {
    const env = {
      SESSION_SECRET: "s",
      COLLABORATION: {
        idFromName: (n: string) => n,
        get: () => ({ fetch: async () => { throw new Error("reset"); } }),
      },
    } as unknown as Env;
    const result = await registerCommittedObjects(env, db, 42, 7, [pending("bell")], { opId: 1 });
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("an object_id refused before the ingest is not", async () => {
    const { env, bodies } = makeEnv(() => Response.json({}));
    const result = await registerCommittedObjects(env, db, 42, 7, [pending("")], { opId: 1 });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(bodies).toHaveLength(0);
  });
});
