/**
 * What the image upload does when the repository's objects.csv yields no
 * reading at all.
 *
 * The upload builds the whole file before it commits anything: it fetches the
 * repository's objects.csv and hands it to `serializeObjectsCsv`, which asks
 * `extractCommentRows` to carry the author's instruction rows through. A file
 * whose rows cannot be matched to the characters they were read from is a
 * `CsvCommentExtractionError` there rather than an empty list, and that throw
 * is by design — publishing a file with the instruction rows silently gone is
 * the outcome it exists to prevent.
 *
 * What must NOT happen is the throw leaving the action. The root error boundary
 * (app/root.tsx) answers an uncaught throw with the crash screen, which loses
 * the upload form, the chosen files and the metadata already typed into it. The
 * action owns the failure instead and answers in its own shape, so the modal
 * reports it and the images stay where they are.
 *
 * The scanner is mocked because no CSV reaches that branch — the delimiter, the
 * terminator and the record boundaries all come from one parse of the file —
 * so what is under test is where the refusal lands, not how one arises. The
 * serializer itself runs for real; a mocked one would prove nothing about the
 * path the error takes.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testGithubAppPrivateKey, installGithubAppFetchStub } from "./helpers/github-app-fetch";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5, objects_read_sha: "head-sha" },
    userRole: "convenor",
  })),
}));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
// The operation lock is granted: these cases are about what the
// action does once it holds it.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "op-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(async () => "object_id,title\n# una instrucción\nobj-1,Un objeto\n"),
  // The upload reads objects.csv strictly, at the head it commits on.
  getFileAtRef: vi.fn(async () => ({ status: "ok", content: "object_id,title\n# una instrucción\nobj-1,Un objeto\n" })),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHead: vi.fn(),
  bumpProjectHeadFrom: vi.fn(async () => true),
  bumpObjectsReadFrom: vi.fn(async () => true),
}));
vi.mock("~/lib/sync.server", () => ({ computeSyncDiff: vi.fn(), applySyncChanges: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(async () => ({ runId: 11, htmlUrl: "https://gh/run/11" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
// The reading the serializer's comment extraction is built on, and the only
// thing mocked between the action and the throw.
vi.mock("~/lib/csv-record-scan.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/csv-record-scan.server")>();
  return {
    readCsvSourceRows: vi.fn(() => null),
    removeObjectRecord: () => ({ status: "unusable" }),
    actualReadCsvSourceRows: actual.readCsvSourceRows,
  };
});
// The serializer runs for real, observed: the refusal cases require that the
// action reached it and that it threw the refusal, so a failure anywhere
// earlier in the action cannot pass for one.
vi.mock("~/lib/csv-export.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/csv-export.server")>();
  return { ...actual, serializeObjectsCsv: vi.fn(actual.serializeObjectsCsv) };
});
vi.mock("~/lib/upload.server", () => ({
  createImageBlobs: vi.fn(async () => []),
  commitMultipleBinaryFilesWithCsv: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  arrayBufferToBase64: vi.fn(() => "base64data"),
  validateUploadFile: vi.fn(() => null),
}));
vi.mock("~/lib/slugify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/slugify")>();
  return { slugify: actual.slugify, generateUniqueObjectSlug: vi.fn() };
});
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), findYMapByIdOrTempId: vi.fn() }));

import { action } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { generateUniqueObjectSlug } from "~/lib/slugify";
import { commitMultipleBinaryFilesWithCsv } from "~/lib/upload.server";
import { CsvCommentExtractionError, serializeObjectsCsv } from "~/lib/csv-export.server";
import * as csvRecordScan from "~/lib/csv-record-scan.server";

/** The repository file the action reads, as `getFileContent` is set to hand it back. */
const EXISTING = "object_id,title\n# una instrucción\nobj-1,Un objeto\n";

function uploadRequest(): Request {
  const form = new FormData();
  form.set("intent", "upload-image");
  form.set("siteId", "42");
  form.append(
    "imageFile",
    new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", { type: "image/jpeg" }),
  );
  form.set(
    "metadataArray",
    JSON.stringify([
      {
        objectId: "fine-id",
        title: "A Title",
        creator: "",
        description: "",
        source: "",
        credit: "",
        period: "",
        year: "",
        altText: "",
      },
    ]),
  );
  return new Request("https://compositor.telar.org/objects", { method: "POST", body: form });
}

function buildContext() {
  const user = { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: testGithubAppPrivateKey(),
  };
  return {
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

function makeDbMock() {
  // The writes an upload that reaches its commit makes: the operation's record
  // and its settling.
  const settle = () => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) });
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) })),
    update: vi.fn(settle),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installGithubAppFetchStub();
  vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5, objects_read_sha: "head-sha" } as never,
    userRole: "convenor",
  });
  vi.mocked(generateUniqueObjectSlug).mockImplementation(async (slug: string) => slug);
  vi.mocked(csvRecordScan.readCsvSourceRows).mockImplementation(() => null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The action called the serializer, and its one call threw the refusal. */
function expectSerializerRefused() {
  const results = vi.mocked(serializeObjectsCsv).mock.results;
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe("throw");
  expect(results[0].value).toBeInstanceOf(CsvCommentExtractionError);
}

describe("an upload whose existing objects.csv yields no reading", () => {
  // The control: without this the failure below could be any of the action's
  // other throws, and the test would report nothing about the refusal.
  it("has a serializer that refuses the file the action reads", () => {
    expect(() => serializeObjectsCsv([], EXISTING)).toThrow(CsvCommentExtractionError);
  });

  it("answers in the action's own failure shape rather than throwing", async () => {
    const res = (await action({
      request: uploadRequest(),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res).toEqual({ ok: false, intent: "upload-image", error: "upload_failed" });
    expectSerializerRefused();
  });

  // The control for the two cases around it: with the reading intact, the same
  // upload commits. Without it, `upload_failed` and no commit could come from
  // any earlier failure in the action, and the cases would pass whatever the
  // serializer did.
  it("commits when the file can be read, so the refusal is what stops it", async () => {
    const { actualReadCsvSourceRows } = csvRecordScan as unknown as {
      actualReadCsvSourceRows: typeof csvRecordScan.readCsvSourceRows;
    };
    vi.mocked(csvRecordScan.readCsvSourceRows).mockImplementation(actualReadCsvSourceRows);

    await action({ request: uploadRequest(), context: buildContext(), params: {} } as never);

    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).toHaveBeenCalledTimes(1);
  });

  it("commits nothing", async () => {
    await action({ request: uploadRequest(), context: buildContext(), params: {} } as never);

    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).not.toHaveBeenCalled();
    expectSerializerRefused();
  });
});
