/**
 * The config save holds `url` and `baseurl` to the rules the Site settings
 * field applies: a changed address that fails them refuses the whole save with
 * the field named, an acceptable one is stored settled, and a value equal to
 * what is stored is never refused, so a site whose stored address predates the
 * rules still saves everything else.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
  resolvePageProject: vi.fn(async () => ({
    kind: "ok" as const,
    project: { id: 42, github_repo_full_name: "owner/repo" },
    userRole: "convenor",
  })),
  siteChangedAnswer: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  getFileOnDefaultBranch: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/yaml.server", () => ({ parseYaml: vi.fn(() => ({})) }));
vi.mock("~/lib/sheets-reconcile.server", () => ({ reconcileSheetsFlagFromRepo: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ getYText: vi.fn() }));

import { action } from "~/routes/_app.config";
import { getDb } from "~/lib/db.server";

function makeDb(stored: { url: string | null; baseurl: string | null } | undefined) {
  const sets: Record<string, unknown>[] = [];
  return {
    sets,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(stored ? [stored] : []) })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        sets.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };
}

function save(fields: Record<string, string>) {
  const form = new URLSearchParams({ siteId: "42", title: "T", ...fields });
  return action({
    request: new Request("https://compositor.telar.org/config", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: { get: vi.fn(() => ({ id: 7, encrypted_access_token: "e" })), cloudflare: { env: { DB: {} } } },
    params: {},
  } as never);
}

let db: ReturnType<typeof makeDb>;
const STORED = { url: "https://old.example.org", baseurl: "/old" };

beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb(STORED);
  vi.mocked(getDb).mockReturnValue(db as never);
});

describe("config action: the site addresses", () => {
  it.each(["example.org", "https://example.org/site", "ftp://example.org"])(
    "refuses a changed Site URL of %j and writes nothing",
    async (url) => {
      const result = await save({ url, baseurl: "/old" });
      expect(result).toEqual({ saved: false, error: "invalid_address", invalidAddresses: ["url"] });
      expect(db.sets).toEqual([]);
    },
  );

  it("names an emptied Site URL with the empty message", async () => {
    expect(await save({ url: "", baseurl: "/old" })).toMatchObject({ invalidAddresses: ["url_empty"] });
  });

  it.each(["no-slash", "/a//b", "/a b?"])("refuses a changed Base URL of %j", async (baseurl) => {
    const result = await save({ url: STORED.url, baseurl });
    expect(result).toMatchObject({ saved: false, invalidAddresses: ["baseurl"] });
    expect(db.sets).toEqual([]);
  });

  it("stores a changed address settled", async () => {
    const result = await save({ url: "https://new.example.org/", baseurl: "/new/" });
    expect(result).toMatchObject({ saved: true });
    expect(db.sets[0]).toMatchObject({ url: "https://new.example.org", baseurl: "/new" });
  });

  it("accepts an empty Base URL", async () => {
    expect(await save({ url: STORED.url, baseurl: "" })).toMatchObject({ saved: true });
    expect(db.sets[0]).toMatchObject({ baseurl: "" });
  });

  it("leaves a stored value the rules would refuse alone when it is unchanged", async () => {
    const legacy = { url: "https://old.example.org/path", baseurl: "legacy/" };
    db = makeDb(legacy);
    vi.mocked(getDb).mockReturnValue(db as never);
    const result = await save({ ...legacy, title: "Edited" });
    expect(result).toMatchObject({ saved: true });
    expect(db.sets[0]).toMatchObject({ ...legacy, title: "Edited" });
  });

  it("saves an unrelated field when the stored Site URL is null", async () => {
    db = makeDb({ url: null, baseurl: null });
    vi.mocked(getDb).mockReturnValue(db as never);
    const result = await save({ url: "", baseurl: "", title: "Edited" });
    expect(result).toMatchObject({ saved: true });
    expect(db.sets[0]).toMatchObject({ title: "Edited" });
  });

  it("refuses a backslash path in a changed Site URL", async () => {
    expect(await save({ url: "https://example.org\\site", baseurl: "/old" })).toMatchObject({
      invalidAddresses: ["url"],
    });
  });

  it("still refuses a legacy value once it is changed to another invalid one", async () => {
    db = makeDb({ url: "https://old.example.org/path", baseurl: "" });
    vi.mocked(getDb).mockReturnValue(db as never);
    expect(await save({ url: "https://old.example.org/other", baseurl: "" })).toMatchObject({
      invalidAddresses: ["url"],
    });
  });
});
