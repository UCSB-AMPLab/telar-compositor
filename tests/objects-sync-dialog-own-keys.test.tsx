// @vitest-environment jsdom
/**
 * The objects page's sync dialog carries a choice for an object whose id names
 * one of Object.prototype's own properties, and the apply writes it.
 * The dialog renders for real, its payload goes through JSON as the form posts
 * it, and the apply runs for real with D1, GitHub and the collaboration object
 * faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === "string" ? fallback : key),
  }),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
  };
});
// The mock database answers its queued rows in order; this file's applies have
// no pending object records, which have their own spec.
vi.mock("~/lib/pending-object-ops.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  completePendingObjectOps: vi.fn(async () => ({ ok: true, outcomes: new Map() })),
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import { SyncDiffDialog, type SyncApplyPayload } from "~/components/features/objects/SyncDiffDialog";
import { applySyncChanges, type SyncChanges, type SyncDiff } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { createTrackedMockDb, d1ObjectRow, PROJECT_ID } from "./sync-probe-fixtures";
import { syncIngestRecorder } from "./helpers/sync-ingest-recorder";

const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";

function diffFor(id: string): SyncDiff {
  return {
    newObjects: [],
    changedObjects: [{
      object_id: id,
      dbId: 1,
      title: "Old",
      changedFields: ["title"],
      conflictFields: [],
      d1Values: { title: "Old" },
      repoValues: { title: "New" },
    }],
    missingObjects: [],
    unregisteredFiles: [],
    reordered: null,
    headSha: HEAD,
  };
}

/** What the dialog posts once the author chooses GitHub's title for `id`. */
function chooseGitHub(id: string): SyncChanges {
  const onApply = vi.fn<(payload: SyncApplyPayload) => void>();
  const { baseElement } = render(
    <SyncDiffDialog open onClose={() => {}} diffData={diffFor(id)} onApply={onApply} isComputing={false} isApplying={false} />,
  );
  const repoRadio = [...baseElement.querySelectorAll<HTMLInputElement>('input[type="radio"][value="repo"]')]
    .find((el) => el.name === `${id}-title`);
  if (!repoRadio) throw new Error(`no repo radio for ${id}.title`);
  fireEvent.click(repoRadio);
  fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));
  return JSON.parse(JSON.stringify(onApply.mock.calls[0][0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
});

describe("the objects page's dialog, with ids that name Object.prototype's own properties", () => {
  it.each(["constructor", "__proto__"])("%s: choosing GitHub's title posts the choice and the apply writes it", async (id) => {
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
      path === OBJECTS_CSV && ref === HEAD ? { status: "ok", content: `object_id,title\n${id},New\n` } : { status: "absent" },
    );

    const posted = chooseGitHub(id);
    expect(Object.hasOwn(posted.fieldChoices, id)).toBe(true);
    expect(posted.fieldChoices[id]).toEqual({ title: "repo" });

    // Not ready, as the empty tree reads it, so the apply recomputes nothing.
    const db = createTrackedMockDb({ responses: [[{ ...d1ObjectRow(), object_id: id, title: "Old", image_available: false }]] });
    const ingest = syncIngestRecorder();
    await applySyncChanges(PROJECT_ID, posted, "t", "o", "r", db, ingest.env, 1);
    expect(ingest.objectsArm()?.update).toEqual([{ objectId: id, docId: 1, fields: { title: "New" }, seen: { title: "Old" } }]);
  });
});
