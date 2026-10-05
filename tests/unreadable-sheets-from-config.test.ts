/**
 * Whether an unreadable sheet is taken from Google Sheets is decided from the
 * `_config.yml` the build reads, never from D1's copy of the setting.
 *
 * The build fetches the published sheet's tabs when `google_sheets.enabled` in
 * `_config.yml` is true, from its `published_url`, and D1's
 * `google_sheets_enabled` can say otherwise. So the full sync's check reads the
 * setting from `_config.yml` at the head it reads everything else at, and the
 * warning says what the build will do with the file.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const gh = vi.hoisted(() => ({
  /** File text by path at the head; absent unless set. */
  files: {} as Record<string, string>,
  /** Paths read at the head whose bytes are not valid UTF-8. */
  lossy: new Set<string>(),
  tabsListed: [] as string[],
}));

vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head1"),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string) => {
    const content = ref === "head1" ? gh.files[path] : undefined;
    if (content === undefined) return { status: "absent" };
    return gh.lossy.has(path) ? { status: "ok", content, lossy: true } : { status: "ok", content };
  }),
  getFileContent: vi.fn(async () => null),
  getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  listSubtreeEntries: vi.fn(async () => ({ files: new Map(), dirs: new Set() })),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

vi.mock("~/lib/sheets.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  discoverSheetTabs: vi.fn(async (url: string) => {
    gh.tabsListed.push(url);
    return [{ name: "glossary" }, { name: "objects" }];
  }),
}));

import { computeFullSyncDiff } from "~/lib/sync.server";
import { project_config } from "~/db/schema";
import { configSheets } from "~/lib/unreadable-characters.server";

const URL_AT_HEAD = "https://docs.google.com/spreadsheets/d/e/AT-HEAD/pubhtml";
const URL_IN_D1 = "https://docs.google.com/spreadsheets/d/e/IN-D1/pubhtml";

/** `_config.yml` with Google Sheets set as `enabled`, from `URL_AT_HEAD`. */
function configWithSheets(enabled: boolean): string {
  return `title: Site\ngoogle_sheets:\n  enabled: ${enabled}\n  published_url: "${URL_AT_HEAD}"\n`;
}

/** A D1 stand-in whose project_config row has Google Sheets set as `enabled`, and no other rows. */
function dbWithSheets(enabled: boolean): never {
  let table: unknown;
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const rows =
            table === project_config ? [{ google_sheets_enabled: enabled, google_sheets_published_url: URL_IN_D1 }] : [];
          table = undefined;
          return (resolve: (v: unknown[]) => unknown) => resolve(rows);
        }
        if (prop === "from") return (t: unknown) => { table = t; return chain; };
        return () => chain;
      },
    },
  );
  return chain as never;
}

async function glossaryEffect(d1Enabled: boolean): Promise<unknown> {
  const diff = await computeFullSyncDiff(1, "tok", "o", "r", dbWithSheets(d1Enabled), null, { collectWarnings: true });
  return diff.warnings?.find((w) => w.code === "unreadable_characters" && w.file === "glossary.csv");
}

beforeEach(() => {
  gh.files = { "telar-content/spreadsheets/glossary.csv": "term_id,title,definition\n" };
  gh.lossy = new Set(["telar-content/spreadsheets/glossary.csv"]);
  gh.tabsListed = [];
});

describe("the full sync's warning for an unreadable sheet", () => {
  it("is from_sheets when _config.yml at the head turns Google Sheets on and D1 has it off, listing the head's URL", async () => {
    gh.files["_config.yml"] = configWithSheets(true);
    expect(await glossaryEffect(false)).toMatchObject({ effect: "from_sheets" });
    expect(gh.tabsListed).toEqual([URL_AT_HEAD]);
  });

  it("stops the build when _config.yml at the head has Google Sheets off and D1 has it on", async () => {
    gh.files["_config.yml"] = configWithSheets(false);
    expect(await glossaryEffect(true)).toMatchObject({ effect: "build_stops" });
    expect(gh.tabsListed).toEqual([]);
  });

  it("stops the build when there is no _config.yml at the head, whatever D1 says", async () => {
    expect(await glossaryEffect(true)).toMatchObject({ effect: "build_stops" });
    expect(gh.tabsListed).toEqual([]);
  });
});

describe("configSheets", () => {
  it("reads enabled and the published URL from the google_sheets block", () => {
    expect(configSheets(configWithSheets(true))).toEqual({ enabled: true, publishedUrl: URL_AT_HEAD });
    expect(configSheets(configWithSheets(false))).toEqual({ enabled: false, publishedUrl: URL_AT_HEAD });
  });

  it("reads an unquoted URL, and trims it as the build does", () => {
    expect(configSheets(`google_sheets:\n  enabled: true\n  published_url: ${URL_AT_HEAD}  \n`)).toEqual({
      enabled: true,
      publishedUrl: URL_AT_HEAD,
    });
  });

  it.each([
    ["a folded block scalar", `  published_url: >-\n    ${URL_AT_HEAD}\n`],
    ["a literal block scalar", `  published_url: |\n    ${URL_AT_HEAD}\n`],
    ["a single-quoted URL", `  published_url: '${URL_AT_HEAD}'\n`],
    ["a double-quoted URL with an escape", `  published_url: "${URL_AT_HEAD.replace("pubhtml", "pub\\x68tml")}"\n`],
  ])("reads the URL written as %s, as PyYAML loads it", (_label, urlLine) => {
    expect(configSheets(`google_sheets:\n  enabled: true\n${urlLine}`)).toEqual({ enabled: true, publishedUrl: URL_AT_HEAD });
  });

  it.each([
    ["yes", true], ["TRUE", true], ["on", true], ["True", true],
    ["false", false], ["no", false], ["'true'", false], ["1", false],
  ])("reads enabled: %s as the build's check does (%s)", (value, enabled) => {
    expect(configSheets(`google_sheets:\n  enabled: ${value}\n  published_url: ${URL_AT_HEAD}\n`)?.enabled).toBe(enabled);
  });

  it("is off with no URL when the file does not load, as the build's own load then fails", () => {
    expect(configSheets(`google_sheets:\n  enabled: true\n  published_url: [unclosed\n`)).toEqual({ enabled: false, publishedUrl: null });
  });

  it("is off with no URL when the file has no google_sheets block, and null with no file", () => {
    expect(configSheets("title: Site\n")).toEqual({ enabled: false, publishedUrl: null });
    expect(configSheets(null)).toBeNull();
  });
});
