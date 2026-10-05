/**
 * A collaboration binding for the objects sync apply, which sends its
 * accepted fields and removals through `/ingest-sync`: each ingest
 * is recorded and answered 200. `objectsArm()` reads the last one's
 * `objects` arm, the only arm the apply sends.
 *
 * @version v1.5.0-beta
 */

export interface RecordedObjectsArm {
  update: Array<{ objectId: string; fields: Record<string, unknown> }>;
  insert: unknown[];
  remove: Array<{ objectId: string; docId: number }>;
}

export function syncIngestRecorder() {
  const bodies: Array<{ objects: RecordedObjectsArm }> = [];
  const env = {
    SESSION_SECRET: "sess-secret",
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          bodies.push(JSON.parse(await req.text()) as { objects: RecordedObjectsArm });
          return Response.json({ applied: {} });
        },
      }),
    },
  } as unknown as Env;
  return {
    env,
    bodies,
    /** The fields the last ingest set on `objectId`, or undefined. */
    fieldsFor(objectId: string): Record<string, unknown> | undefined {
      return bodies.at(-1)?.objects.update.find((u) => u.objectId === objectId)?.fields;
    },
    objectsArm(): RecordedObjectsArm | undefined {
      return bodies.at(-1)?.objects;
    },
  };
}
