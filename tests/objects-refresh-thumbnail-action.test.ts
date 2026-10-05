/**
 * The object-thumbnail route: an external object whose stored thumbnail failed
 * to load takes the manifest's current one, and only for a member of the
 * project the request names.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/membership.server", () => ({ getUserRole: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));

import { action } from "~/routes/api.object-thumbnail";
import { getDb } from "~/lib/db.server";
import { getUserRole } from "~/lib/membership.server";
import { fetchAndParseManifest } from "~/lib/iiif.server";

const STORED = { id: 9, project_id: 42, source_url: "https://iiif.example/manifest", thumbnail: "https://iiif.example/old.jpg" };

function dbWith(rows: unknown[]) {
  const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) }));
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })) })) })),
    update: vi.fn(() => ({ set })),
  } as never);
  return set;
}

async function post(fields: Record<string, string> = { projectId: "42", objectDbId: "9" }) {
  const request = new Request("https://compositor.telar.org/api/object-thumbnail", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const context = {
    get: vi.fn(() => ({ id: 7 })),
    cloudflare: { env: { DB: {} } },
  } as never;
  const response = (await action({ request, context, params: {} } as never)) as Response;
  return response.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserRole).mockResolvedValue("convenor");
});

describe("the object-thumbnail route", () => {
  it("answers the manifest's current thumbnail when it differs, and writes nothing", async () => {
    const set = dbWith([STORED]);
    vi.mocked(fetchAndParseManifest).mockResolvedValue({ ok: true, metadata: { thumbnail: "https://iiif.example/new.jpg" } } as never);

    expect(await post()).toEqual({ changed: true, thumbnail: "https://iiif.example/new.jpg" });
    expect(set).not.toHaveBeenCalled();
  });

  it("answers the new thumbnail again when the first response was lost", async () => {
    const set = dbWith([STORED]);
    vi.mocked(fetchAndParseManifest).mockResolvedValue({ ok: true, metadata: { thumbnail: "https://iiif.example/new.jpg" } } as never);

    await post();
    expect(await post()).toEqual({ changed: true, thumbnail: "https://iiif.example/new.jpg" });
    expect(set).not.toHaveBeenCalled();
  });

  it("writes nothing when the manifest still names the stored thumbnail", async () => {
    const set = dbWith([STORED]);
    vi.mocked(fetchAndParseManifest).mockResolvedValue({ ok: true, metadata: { thumbnail: STORED.thumbnail } } as never);

    expect(await post()).toEqual({ changed: false });
    expect(set).not.toHaveBeenCalled();
  });

  it("reads and writes nothing for a caller who is not a member of the named project", async () => {
    const set = dbWith([STORED]);
    vi.mocked(getUserRole).mockResolvedValue(null);

    expect(await post()).toEqual({ changed: false });
    expect(fetchAndParseManifest).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("reads nothing for an id the project has no object for", async () => {
    const set = dbWith([]);

    expect(await post()).toEqual({ changed: false });
    expect(fetchAndParseManifest).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
