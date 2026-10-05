/**
 * A stand-in for `~/lib/pending-object-ops.server` for route tests whose
 * subject is not the operation record: no rows to complete, the commit run
 * as given, and the registration handed straight to
 * `registerCommittedObjects` — the mocked one, where the test mocks it — with
 * the operation's id. The sheet reads are the real ones, over whatever the
 * test's `~/lib/github.server` mock answers.
 *
 * Use as `vi.mock("~/lib/pending-object-ops.server", () =>
 * import("./helpers/pending-object-ops-passthrough"))`. The record itself is
 * tested in tests/pending-object-ops.test.ts and
 * tests/objects-pending-op-lifecycle.test.ts.
 *
 * @version v1.5.0-beta
 */

import { vi } from "vitest";
import { registerCommittedObjects } from "~/lib/register-objects.server";
import type * as PendingObjectOps from "~/lib/pending-object-ops.server";

const actual = await vi.importActual<typeof PendingObjectOps>("~/lib/pending-object-ops.server");

/** The operation id every recorded commit is given. */
export const PASSTHROUGH_OP_ID = 1;

export const PREPARED_OP_HOLD_MS = actual.PREPARED_OP_HOLD_MS;
export const parseSheetObjectIds = actual.parseSheetObjectIds;
export const sheetObjectIds = actual.sheetObjectIds;
export const readObjectsSheetAt = actual.readObjectsSheetAt;
export const pendingObjectOpIdOf = actual.pendingObjectOpIdOf;
export const prepareObjectsCommit = vi.fn(
  async (
    _env: unknown,
    _db: unknown,
    _projectId: number,
    at: { token: string; owner: string; repo: string; head: string },
  ) => {
    const { path, file, sheet } = await actual.readObjectsSheetAt(at.token, at.owner, at.repo, at.head);
    if (sheet === null) throw new actual.ObjectsCommitUnready("unreadable", "objects.csv could not be read");
    return { path, existingCsv: file.status === "ok" ? file.content : undefined };
  },
);

export const completePendingObjectOps = vi.fn(async () => ({ ok: true as const, outcomes: new Map() }));
export const ObjectsCommitUnready = actual.ObjectsCommitUnready;
export const ObjectsSheetChanged = actual.ObjectsSheetChanged;
export const preparePendingObjectOp = vi.fn(async () => PASSTHROUGH_OP_ID);
export const prepareRegistrationRecord = vi.fn(
  async (_db: unknown, input: { objects: unknown[] }) => (input.objects.length === 0 ? null : PASSTHROUGH_OP_ID),
);
export const markPendingObjectOpCommitted = vi.fn(async () => {});
export const deletePendingObjectOp = vi.fn(async () => {});
export const readPendingObjectOp = vi.fn(async () => null);
export const ingestRemoval = vi.fn(async () => true);
export const removeThroughCommittedRecord = vi.fn(async () => ({ ok: true as const, pending: false }));
export const commitUnderRecord = vi.fn(
  async <T>(_db: unknown, _opId: number, commit: () => Promise<T>): Promise<T> => commit(),
);
export const finishRecordedRegistration = vi.fn(
  async (
    env: Parameters<typeof registerCommittedObjects>[0],
    db: Parameters<typeof registerCommittedObjects>[1],
    projectId: number,
    actorId: number,
    objects: Parameters<typeof registerCommittedObjects>[4],
    opId: number | null,
  ) => (opId === null
    ? { ok: true, insertedCount: 0, alreadyPresent: [], failed: [], operationId: null }
    : {
      ...(await registerCommittedObjects(env, db, projectId, actorId, objects, { opId })),
      operationId: opId,
    }),
);
