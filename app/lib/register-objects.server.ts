/**
 * Register objects whose commit has landed, through the collaboration object.
 *
 * Called by the Objects page's two committing actions as soon as the commit is
 * in the repository, and by its retry. Registration follows the commit and not
 * the build: the images and `objects.csv` rows are committed whatever the
 * build then does, and a publish writes `objects.csv` from D1, so an object
 * that is committed and not registered is removed from the site by the next
 * publish. The build decides only when an object's tiles exist.
 *
 * The row is written by the collaboration DO, never here. A direct
 * INSERT sits outside the snapshot gate, and the snapshot is a second writer
 * of this table: it INSERTs every Y.Map whose `_id` is still null, and its
 * dedupe pass mints replacement object_ids from a key set read at the top of
 * that pass. Either can take the key this call is carrying, and with no UNIQUE
 * index nothing aborts — D1 ends up holding two rows under one object_id, both
 * published into objects.csv. Posting an `objects.insert` arm to /ingest-sync
 * puts the write inside the gate, where presence is decided by the document
 * the snapshot writes from rather than by a read the write can outlive.
 *
 * Never throws, and is idempotent by object_id: a failure is answered so the
 * caller can offer a retry, and repeating the call skips what already landed.
 * With an operation id it is idempotent by operation as well: the ingest keeps
 * a receipt for each id it has applied, so an object registered and since
 * deleted from the document is not brought back by a repeat.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";

import { objects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import type { PendingObject } from "~/lib/sync.server";
import type { SheetEntry } from "~/lib/field-order";
import type { IngestObjectInsert } from "../../workers/collaboration";
import { partitionOnIdentityDomain } from "../../workers/can-delete";
import { partitionIngestArm } from "../../workers/ingest-domains";

export interface RegistrationResult {
  ok: boolean;
  error?: "insert_failed";
  message?: string;
  insertedCount?: number;
  alreadyPresent?: string[];
  failed?: string[];
  /**
   * The ingest had already applied this operation id, so nothing was applied
   * again. A success: the objects reached the document the first time.
   */
  alreadyApplied?: boolean;
  /**
   * On a failure, whether sending the same registration again can succeed. An
   * unanswered ingest or an insert D1 refused can; an object_id out of domain
   * never can, and a record that waited on it would wait for good.
   */
  retryable?: boolean;
  /**
   * The pending operation this registration completes, set by the committing
   * action so its client can name it in a retry. Null when there is none.
   */
  operationId?: number | null;
}

/** Options for one registration. */
export interface RegistrationOptions {
  /**
   * The pending operation's id, sent as the ingest's `opId`: an ingest that
   * already applied it answers so and applies nothing a second time.
   */
  opId?: number;
  /**
   * GitHub's objects.csv in order, sent as the ingest's `objects.sheet`: each
   * object it names without a D1 id is placed between the rows GitHub has
   * either side of it. Only the objects sync's registration of rows it brings
   * in from GitHub passes one; an object uploaded or added in the Compositor
   * sorts after every row.
   */
  sheet?: SheetEntry[];
}

export async function registerCommittedObjects(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: ReturnType<typeof getDb>,
  projectId: number,
  actorId: number | null,
  pendingObjects: PendingObject[],
  options: RegistrationOptions = {},
): Promise<RegistrationResult> {
  // The callers run after a commit has landed, where a throw would report the
  // commit as failed; whatever goes wrong here is answered as a retryable
  // failure instead.
  try {
    return await register(env, db, projectId, actorId, pendingObjects, options);
  } catch (err) {
    console.error(`registerCommittedObjects: registration failed for project ${projectId}:`, err);
    return {
      ok: false,
      error: "insert_failed",
      retryable: true,
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function register(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: ReturnType<typeof getDb>,
  projectId: number,
  actorId: number | null,
  pendingObjects: PendingObject[],
  options: RegistrationOptions,
): Promise<RegistrationResult> {
  // Nothing to register: answer without waking the DO. An empty ingest
  // would still cost a snapshot on a project with no reason to take one.
  if (pendingObjects.length === 0) {
    return {
      ok: true,
      insertedCount: 0,
      alreadyPresent: [],
      failed: [],
    };
  }

  // `origin` is provenance sync reads as a classifier: a "compositor" object
  // is never flagged missing from the repo, which is what keeps an author's own
  // upload off the "(removed)" list when its CSV commit failed. `buildObjectYMap`
  // accepts "compositor" and "repo", so those ride the document and reach D1
  // through the snapshot's own INSERT, including one that lands at a later
  // snapshot after D1 refused it at the flush. Any other value cannot be
  // carried and is patched in after the ingest, once the row exists.
  //
  // `missing_from_repo` needs no residue: the snapshot INSERT binds 0,
  // which is what a freshly registered object carries.
  const originOf = (p: PendingObject) => p.origin ?? "compositor";

  // The submitted JSON is client-supplied, and parsing it as an array says
  // nothing about what the entries hold. An `object_id` that is not a
  // legal identity value is refused here as well as at the DO: a
  // structural value renders to a colleague's key in the snapshot's
  // reconciliation and so claims their row, and an empty one is read as
  // unkeyed and published that way. The DO's own boundary is the fix —
  // `/ingest-sync` is reachable by anything holding the internal marker —
  // and this is the outermost place the same rule can be stated.
  const vetted = partitionOnIdentityDomain(
    pendingObjects, "objects", (p) => p.object_id,
  );
  if (vetted.refused.length > 0) {
    // By position, never by value: rendering an untrusted value to log it
    // is the same operation that turns one into a colleague's key.
    console.error(
      `registerCommittedObjects: refused ${vetted.refused.length} pending object(s) ` +
        `for project ${projectId} at position(s) ${vetted.refused.join(", ")} — ` +
        `object_id out of domain`,
    );
  }
  // Nothing legal to register. The DO is not woken for a payload with no
  // acceptable entry, but the answer is still a failure: the images are
  // already in the repo and nothing was registered against them.
  if (vetted.accepted.length === 0) {
    return {
      ok: false,
      error: "insert_failed" as const,
      retryable: false,
      insertedCount: 0,
      alreadyPresent: [],
      failed: [],
    };
  }

  const inserts = toIngestInserts(vetted.accepted, actorId);
  // Keyed by object_id, so it can only cover entries whose object_id is a
  // legal key — the refused ones have no row to patch and no key to patch
  // it by.
  const originResidue = new Map(
    vetted.accepted
      .filter((p) => !isCarriedOrigin(originOf(p)))
      .map((p) => [p.object_id, originOf(p)] as const),
  );

  const insHeaders = await makeInternalMarkerHeaders(
    projectId,
    env.SESSION_SECRET,
    "ingest-sync",
  );
  const insStub = env.COLLABORATION.get(
    env.COLLABORATION.idFromName(String(projectId)),
  );

  // The fetch and the JSON parse share one guard because a DO rejection is
  // not the same event as a non-2xx response: an exception escaping a
  // blockConcurrencyWhile callback gets the instance terminated by
  // Cloudflare and the in-flight fetch rejects rather than answering. Left
  // unguarded it would escape the action entirely and the route's error
  // boundary would replace the objects tab under a modal mid-flight. Both
  // outcomes are told to the user as the same retryable failure the modal
  // already offers, and repeating the post is safe: the ingest is
  // idempotent by object_id.
  let ingestBody: {
    alreadyApplied?: boolean;
    applied?: { objectInsert?: number };
    skipped?: { objectInsert?: string[] };
    failed?: { objectInsert?: string[] };
    refused?: { objectInsert?: number[] };
  };
  try {
    const ingestRes = await insStub.fetch(
      new Request("https://internal/ingest-sync", {
        method: "POST",
        headers: { ...insHeaders, "Content-Type": "application/json" },
        // An absent `opId` is dropped by the serialisation, so an ingest
        // without one keeps its receipt-less meaning.
        body: JSON.stringify({ opId: options.opId, objects: { insert: inserts, sheet: options.sheet } }),
      }),
    );
    if (!ingestRes.ok) {
      console.error(
        `object registration ingest failed for project ${projectId}: DO returned ${ingestRes.status}`,
      );
      return {
        ok: false,
        error: "insert_failed" as const,
        retryable: true,
        message: `ingest-sync returned ${ingestRes.status}`,
      };
    }
    ingestBody = (await ingestRes.json()) as {
      alreadyApplied?: boolean;
      applied?: { objectInsert?: number };
      skipped?: { objectInsert?: string[] };
      failed?: { objectInsert?: string[] };
      refused?: { objectInsert?: number[] };
    };
  } catch (err) {
    console.error(
      `object registration ingest unreachable for project ${projectId}:`,
      err,
    );
    return {
      ok: false,
      error: "insert_failed" as const,
      retryable: true,
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }

  // The operation reached the document before, and its answer was lost. The
  // residue below is not written: which rows that ingest created is not known
  // here, and the origin it patches is cosmetic.
  if (ingestBody.alreadyApplied === true) {
    return { ok: true, alreadyApplied: true, insertedCount: 0, alreadyPresent: [], failed: [] };
  }

  const alreadyPresent = ingestBody.skipped?.objectInsert ?? [];
  // A refused INSERT is its own outcome: the object is in the document with
  // a null `_id`, so the next snapshot re-issues it, but D1 does not hold
  // it yet and a publish taken now would omit it.
  const refused = ingestBody.failed?.objectInsert ?? [];
  if (refused.length > 0) {
    console.error(
      `registerCommittedObjects: D1 refused ${refused.length} insert(s) for project ${projectId}: ${refused.join(", ")}`,
    );
  }
  // Entries the DO's own boundary refused for an out-of-domain object_id,
  // reported by position in the arm this action sent. Every one of those
  // entries already passed the identical rule here, so a non-empty list
  // means the two disagree — a condition worth a loud log rather than a
  // quiet subtraction.
  const outOfDomainAt = ingestBody.refused?.objectInsert ?? [];
  if (outOfDomainAt.length > 0) {
    console.error(
      `registerCommittedObjects: the DO refused ${outOfDomainAt.length} insert(s) for ` +
        `project ${projectId} at position(s) ${outOfDomainAt.join(", ")} — ` +
        `object_id out of domain after this action accepted it`,
    );
  }
  const outOfDomain = outOfDomainAt
    .map((position) => inserts[position]?.object_id)
    .filter((objectId): objectId is string => objectId !== undefined);

  // Residue for the rows this ingest created, and only those. A skipped
  // object_id already had a row carrying an origin of its own, and a
  // refused one has no row to patch; writing either would reclassify an
  // object nobody asked to change. A failure here is cosmetic — sync reads
  // only the "compositor" value specially — so it is logged, not raised.
  // Only an origin the insert cannot carry reaches this pass.
  const untouched = new Set([...alreadyPresent, ...refused, ...outOfDomain]);
  const insNow = new Date().toISOString();
  try {
    for (const [objectId, origin] of originResidue) {
      if (untouched.has(objectId)) continue;
      await db
        .update(objects)
        .set({ origin, updated_at: insNow })
        .where(
          and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)),
        );
    }
  } catch (err) {
    console.error("registerCommittedObjects: origin residue write failed", err);
  }

  // `ok` is what the modal reads to choose between its success step and
  // `insert_failed`, so a refusal has to answer false: the images are
  // already committed to the repo, and a success banner over an object D1
  // does not hold leaves the author with no reason to retry — and the
  // retry, not a discard, is the remedy. The counts ride along either way
  // so the caller can say which objects landed.
  //
  // An entry refused before it ever reached the document answers the same
  // way, and the `failed` list deliberately does not name it: the only
  // name it has is the value the domain rule rejected, and putting that in
  // a response is the rendering the rule exists to prevent.
  const anyRefused =
    refused.length > 0 || vetted.refused.length > 0 || outOfDomainAt.length > 0;
  // Only an insert D1 refused is worth sending again: its object waits in the
  // document for its row. An entry refused for its object_id is refused again.
  return {
    ok: !anyRefused,
    ...(anyRefused ? { error: "insert_failed", retryable: refused.length > 0 } : {}),
    insertedCount: ingestBody.applied?.objectInsert ?? 0,
    alreadyPresent,
    failed: refused,
  };
}

/**
 * The ingest's insert entries for `pendingObjects`, as `actorId` registers
 * them. `origin` rides the wire as "compositor" or "repo", the values the Y.Map
 * carries; every other value is patched into D1 after the ingest.
 */
export function toIngestInserts(pendingObjects: PendingObject[], actorId: number | null): IngestObjectInsert[] {
  return pendingObjects.map((p) => ({
    object_id: p.object_id,
    title: p.title,
    featured: p.featured,
    creator: p.creator,
    description: p.description,
    source_url: p.source_url,
    period: p.period,
    year: p.year,
    object_type: p.object_type,
    subjects: p.subjects,
    source: p.source,
    credit: p.credit,
    thumbnail: p.thumbnail,
    alt_text: p.alt_text ?? null,
    dimensions: p.dimensions ?? null,
    extra_columns: p.extra_columns ?? null,
    image_available: p.image_available,
    created_by: actorId,
    ...carriedOrigin(p.origin ?? "compositor"),
  }));
}

/** Whether the ingest's insert carries `origin` itself. */
function isCarriedOrigin(origin: string): origin is "compositor" | "repo" {
  return origin === "compositor" || origin === "repo";
}

/** The insert's `origin` entry for `origin`: only a value the insert carries. */
function carriedOrigin(origin: string): { origin?: "compositor" | "repo" } {
  return isCarriedOrigin(origin) ? { origin } : {};
}

/**
 * Whether the ingest would take every one of `pendingObjects`, judged by the
 * very rules its boundary applies (`partitionIngestArm`: shape, identity, then
 * each field's domain). A committing action asks before it commits: an object
 * the ingest refuses would sit in the repository with nothing able to register
 * it, and its record would wait on it for good.
 */
export function pendingObjectsInDomain(pendingObjects: unknown, actorId: number | null): boolean {
  if (!Array.isArray(pendingObjects)) return false;
  const shaped = pendingObjects.every((p) => typeof p === "object" && p !== null && !Array.isArray(p));
  if (!shaped) return false;
  const inserts = toIngestInserts(pendingObjects as PendingObject[], actorId);
  return partitionIngestArm(inserts, "objectInsert", (i) => i.object_id, []).refused.length === 0;
}
