/**
 * The upgrade's sheet stage on a site that reads Google Sheets: the build's test on the `_config.yml` the
 * upgrade commits, the tabs standing in for the repository copies they replace, a tab the 1.8.0 build
 * would refuse offering to stop reading Google Sheets, declining it stopping
 * the upgrade by name and accepting it writing the tabs as the site's CSVs
 * with `_config.yml` switched off, a clean Sheets site going ahead
 * with its tabs checked as they stood, a tab written through a link checked
 * where it lands, and the tabs bound in the challenge.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it, vi } from "vitest";

import { isGoogleSheetsOn } from "~/lib/pyyaml";
import { PublishedSheetUnreadableError, type PublishedTab } from "~/lib/sheets.server";
import { runSheetStage, type SheetStageInput, type SheetStageResult, type SpreadsheetEntry } from "~/lib/upgrade-sheets.server";

const DIR = "telar-content/spreadsheets";
const PUB = "https://docs.google.com/spreadsheets/d/e/PUB/pubhtml";
const sheetsConfig = (enabled: string) => `telar:\n  version: "1.8.0"\ngoogle_sheets:\n  enabled: ${enabled}\n  published_url: "${PUB}"\n`;
const ON = sheetsConfig("true");

const CLEAN = "step,answer\n1,Here.\n";
const BOTH_HOLD = "step,answer,note,Note\n1,Here.,a,b\n";
const EMPTY_DUPLICATE = "step,answer,note,Note\n1,Here.,,x\n";

const tab = (name: string, text: string, gid = `g-${name}`): PublishedTab => ({ name, gid, file: `${name.toLowerCase()}.csv`, text });

interface SheetsSite {
  files: Record<string, string>;
  /** Links in the spreadsheets directory, by name, to the path each holds. */
  links?: Record<string, string>;
  config?: string;
  tabs?: PublishedTab[] | Error;
}

function tabsInput(site: SheetsSite, extra: Partial<SheetStageInput> = {}): SheetStageInput {
  const entries: SpreadsheetEntry[] = [
    ...Object.keys(site.files).map((path) => ({ path, mode: "100644", sha: `sha-${path}` })),
    ...Object.keys(site.links ?? {}).map((name) => ({ path: `${DIR}/${name}`, mode: "120000", sha: `link-${name}` })),
  ];
  const readTabs = vi.fn(async (url: string) => {
    expect(url).toBe(PUB);
    if (site.tabs instanceof Error) throw site.tabs;
    return site.tabs ?? [];
  });
  return {
    listEntries: async () => entries,
    readRaw: async (path) => site.files[path] ?? null,
    targetExists: async (path) => path in site.files,
    readLinkTarget: async (entry) => (site.links ?? {})[entry.path.slice(DIR.length + 1)],
    readTabs,
    chainFiles: new Map([["_config.yml", site.config ?? ON]]),
    targetTag: "v1.8.0",
    headOid: "head-1",
    challenge: null,
    submitted: null,
    ...extra,
  };
}

async function tabsStage(site: SheetsSite, extra: Partial<SheetStageInput> = {}): Promise<SheetStageResult> {
  return runSheetStage(tabsInput(site, extra));
}

/**
 * The stage's answer once the author declines the offer to stop reading
 * Google Sheets: the offer is made first, with the tabs and columns it names,
 * and keeping Google Sheets stops the upgrade naming the same.
 */
async function declined(site: SheetsSite, extra: Partial<SheetStageInput> = {}): Promise<SheetStageResult> {
  const offer = await tabsStage(site, extra);
  if (offer.kind !== "needs_sheets_decision") return offer;
  const result = await tabsStage(site, { ...extra, challenge: offer.challenge, sheetsAnswer: "keep" });
  if (result.kind === "failed" && result.error === "sheets_columns_refused") expect(result.detail).toEqual(offer.detail);
  return result;
}

describe("a tab the 1.8.0 build would refuse", () => {
  it("stops the upgrade with sheets_columns_refused, naming the tab, once the author keeps Google Sheets", async () => {
    const result = await declined({
      files: { [`${DIR}/my-story.csv`]: CLEAN },
      tabs: [tab("project", "order,story_id\n1,my-story\n"), tab("my-story", BOTH_HOLD)],
    });
    expect(result).toEqual({
      kind: "failed",
      error: "sheets_columns_refused",
      detail: { tabs: "my-story", count: 1, collisions: [{ tab: "my-story", columns: ["note", "Note"] }] },
    });
  });

  it("refuses a tab the framework would repair on its own too, since a live tab is never written", async () => {
    const result = await declined({ files: {}, tabs: [tab("my-story", EMPTY_DUPLICATE), tab("other", EMPTY_DUPLICATE)] });
    expect(result).toEqual({
      kind: "failed",
      error: "sheets_columns_refused",
      detail: {
        tabs: "my-story, other",
        count: 2,
        collisions: [
          { tab: "my-story", columns: ["note", "Note"] },
          { tab: "other", columns: ["note", "Note"] },
        ],
      },
    });
  });

  it("stops at once, under the tab's name, where the repair would stop anyway", async () => {
    const result = await tabsStage({ files: {}, tabs: [tab("my-story", BOTH_HOLD), tab("other", "step,answer,_metadata\n1,Here.,x\n")] });
    expect(result).toEqual({ kind: "failed", error: "sheet_reserved_column", detail: { sheet: "other", column: "_metadata", tab: true } });
  });

  it("checks a tab on its text as fetched, not on the manifest chain's edit of the file it replaces", async () => {
    const result = await declined(
      { files: { [`${DIR}/project.csv`]: "order,story_id\n1,s\n" }, tabs: [tab("project", "order,story_id,title,Title\n1,s,a,b\n")] },
      { chainFiles: new Map([["_config.yml", ON], [`${DIR}/project.csv`, "order,story_id\n1,s\n"]]) },
    );
    expect(result).toMatchObject({ kind: "failed", error: "sheets_columns_refused", detail: { tabs: "project" } });
  });

  it("marks the stop of a repository sheet as not a tab's", async () => {
    const result = await tabsStage({ files: { [`${DIR}/old.csv`]: "step,answer,_metadata\n1,Here.,x\n" }, tabs: [tab("my-story", CLEAN)] });
    expect(result).toEqual({ kind: "failed", error: "sheet_reserved_column", detail: { sheet: "old.csv", column: "_metadata" } });
  });
});

// The glossary reads `tipo` as `kind`; a story does not.
const GLOSSARY_COLLIDING = "term_id,kind,tipo\nx,a,b\n";

describe("a tab written through a link", () => {
  it("is checked where it lands, under that file's role", async () => {
    const files = { [`${DIR}/glossary.csv`]: "term_id,kind\nx,a\n" };
    const alone = await tabsStage({ files, tabs: [tab("my-story", GLOSSARY_COLLIDING)] });
    expect(alone).toMatchObject({ kind: "ready", tabsChecked: true });
    const linked = await declined({ files, links: { "my-story.csv": "glossary.csv" }, tabs: [tab("my-story", GLOSSARY_COLLIDING)] });
    expect(linked).toEqual({
      kind: "failed",
      error: "sheets_columns_refused",
      detail: { tabs: "my-story", count: 1, collisions: [{ tab: "my-story", columns: ["kind", "tipo"] }] },
    });
  });

  it("is read in place of the file it lands in, there and through the link", async () => {
    const result = await tabsStage({
      files: { [`${DIR}/glossary.csv`]: "term_id,kind,Kind\nx,a,b\n" },
      links: { "my-story.csv": "glossary.csv" },
      tabs: [tab("my-story", "term_id,kind\nx,From the tab.\n", "7")],
    });
    if (result.kind !== "ready") throw new Error(result.kind);
    expect(result.writes).toEqual([]);
    expect(result.finalSheets.map((s) => [s.name, s.role, s.text])).toEqual([
      ["glossary.csv", "glossary", "term_id,kind\nx,From the tab.\n"],
      ["my-story.csv", "story", "term_id,kind\nx,From the tab.\n"],
    ]);
  });

  it("is read as the last tab written where two tabs land in one file", async () => {
    const result = await tabsStage({
      files: { [`${DIR}/glossary.csv`]: "term_id,kind\nx,a\n" },
      links: { "my-story.csv": "glossary.csv" },
      tabs: [tab("my-story", GLOSSARY_COLLIDING), tab("glossary", "term_id,kind\nx,a\n")],
    });
    expect(result).toMatchObject({ kind: "ready", tabsChecked: true });
  });

  it("is checked where it lands when the link's target is not in the repository, since the build creates it", async () => {
    const links = { "my-story.csv": "glossary.csv" };
    const refused = await declined({ files: {}, links, tabs: [tab("my-story", GLOSSARY_COLLIDING)] });
    expect(refused).toEqual({
      kind: "failed",
      error: "sheets_columns_refused",
      detail: { tabs: "my-story", count: 1, collisions: [{ tab: "my-story", columns: ["kind", "tipo"] }] },
    });
    const clean = await tabsStage({ files: {}, links, tabs: [tab("my-story", "term_id,kind\nx,a\n")] });
    if (clean.kind !== "ready") throw new Error(clean.kind);
    expect(clean.finalSheets.map((s) => [s.name, s.role])).toEqual([["glossary.csv", "glossary"], ["my-story.csv", "story"]]);
  });

  it("is checked at the link itself where the link leaves the site, as the build reads it back through the link", async () => {
    const links = { "my-story.csv": "../../../outside.csv" };
    const refused = await declined({ files: {}, links, tabs: [tab("my-story", BOTH_HOLD)] });
    expect(refused).toMatchObject({ kind: "failed", error: "sheets_columns_refused", detail: { tabs: "my-story" } });
    const clean = await tabsStage({ files: {}, links, tabs: [tab("my-story", CLEAN)] });
    expect(clean).toMatchObject({ kind: "ready", tabsChecked: true, report: [] });
  });
});

describe("a clean Sheets site", () => {
  it("goes ahead with its tabs checked, leaving the repository copies the tabs replace as they are", async () => {
    const result = await tabsStage({
      files: { [`${DIR}/my-story.csv`]: BOTH_HOLD },
      tabs: [tab("my-story", CLEAN)],
    });
    expect(result).toMatchObject({ kind: "ready", writes: [], report: [], tabsChecked: true, advancesHead: true });
  });

  it("repairs a repository CSV no tab replaces, as any site's", async () => {
    const result = await tabsStage({ files: { [`${DIR}/old.csv`]: EMPTY_DUPLICATE }, tabs: [tab("my-story", CLEAN)] });
    expect(result).toMatchObject({ kind: "ready", tabsChecked: true });
    if (result.kind !== "ready") return;
    expect(result.writes.map((w) => w.path)).toEqual([`${DIR}/old.csv`]);
  });

  it("gives the answer check the tabs' text, as fetched, for the files they replace", async () => {
    const fetched = "step,answer\r\n1,From the tab.\u000b\r\n";
    const result = await tabsStage(
      { files: { [`${DIR}/my-story.csv`]: "step,answer\n1,From the repository.\n" }, tabs: [tab("my-story", fetched)] },
      { chainFiles: new Map([["_config.yml", ON], [`${DIR}/my-story.csv`, "step,answer\n1,From the chain.\n"]]) },
    );
    if (result.kind !== "ready") throw new Error(result.kind);
    expect(result.finalSheets).toEqual([{ name: "my-story.csv", role: "story", text: fetched }]);
  });

  it("checks a tab on its raw text: one that collides only once cleaned goes ahead, as the build reads it raw", async () => {
    const result = await tabsStage({ files: {}, tabs: [tab("my-story", "step,answer,note,No\u007fte\n1,Here.,a,b\n")] });
    expect(result).toMatchObject({ kind: "ready", tabsChecked: true, writes: [] });
  });

  it("names a tab's file as the build does, so a Spanish objects tab stands beside an English repository file", async () => {
    const result = await tabsStage({
      files: { [`${DIR}/objects.csv`]: "object_id,title\na,A\n" },
      tabs: [tab("Objetos", "object_id,title,Title\na,A,B\n")],
    });
    // The build reads objects.csv, English first; the objetos tab is neither
    // converted nor checked.
    expect(result).toMatchObject({ kind: "ready", tabsChecked: true });
  });
});

describe("whether the site reads Google Sheets", () => {
  it.each(["true", "yes", "on", "True", "ON", '"True"', "'True'"])("reads the tabs for enabled: %s", async (enabled) => {
    const input = tabsInput({ files: {}, config: sheetsConfig(enabled), tabs: [tab("my-story", CLEAN)] });
    expect(await runSheetStage(input)).toMatchObject({ kind: "ready", tabsChecked: true });
    expect(input.readTabs).toHaveBeenCalledOnce();
  });

  it.each(["false", "no", "'yes'", '"true"'])("reads no tab for enabled: %s, and checks the repository copies", async (enabled) => {
    const input = tabsInput({ files: { [`${DIR}/my-story.csv`]: EMPTY_DUPLICATE }, config: sheetsConfig(enabled), tabs: [tab("my-story", BOTH_HOLD)] });
    const result = await runSheetStage(input);
    expect(result).toMatchObject({ kind: "ready", tabsChecked: false });
    expect(input.readTabs).not.toHaveBeenCalled();
  });

  // build.yml fetches when str(enabled) == "True", which a quoted "True" is.
  it('reads the tabs for a quoted enabled: "True", as build.yml does', async () => {
    const input = tabsInput({ files: {}, config: sheetsConfig('"True"'), tabs: [tab("my-story", CLEAN)] });
    expect(await runSheetStage(input)).toMatchObject({ kind: "ready", tabsChecked: true });
    expect(input.readTabs).toHaveBeenCalledOnce();
  });

  it("tests the _config.yml the upgrade commits, not the one at the head", async () => {
    const input = tabsInput({ files: {}, tabs: [tab("my-story", BOTH_HOLD)] }, { chainFiles: new Map([["_config.yml", sheetsConfig("false")]]) });
    expect(await runSheetStage(input)).toMatchObject({ kind: "ready", tabsChecked: false });
  });

  it("stops where the tabs cannot be read", async () => {
    const result = tabsStage({ files: {}, tabs: new PublishedSheetUnreadableError("my-story") });
    await expect(result).rejects.toMatchObject({ tab: "my-story" });
  });
});

describe("the tabs in the challenge", () => {
  const site = (tabText: string): SheetsSite => ({ files: { [`${DIR}/old.csv`]: BOTH_HOLD }, tabs: [tab("my-story", tabText, "7")] });
  const KEEP = [{ file: `${DIR}/old.csv`, positions: [2, 3], keep: 3 }];

  async function tabsQuestion(s: SheetsSite) {
    const result = await tabsStage(s);
    if (result.kind !== "needs_choices") throw new Error(result.kind);
    return result;
  }

  it("binds the tabs read and each tab's text, by its source", async () => {
    const { challenge } = await tabsQuestion(site(CLEAN));
    expect(challenge.tabs).toEqual([{ name: "my-story", gid: "7" }]);
    expect(challenge.sheets.map((s) => [s.file, s.source])).toEqual([
      [`${DIR}/my-story.csv`, { tab: "my-story", gid: "7" }],
      [`${DIR}/old.csv`, "repo"],
    ]);
  });

  it("replays the choices when the tabs are as they were", async () => {
    const first = await tabsQuestion(site(CLEAN));
    const result = await tabsStage(site(CLEAN), { challenge: first.challenge, submitted: KEEP });
    expect(result).toMatchObject({ kind: "ready", tabsChecked: true, advancesHead: false });
  });

  it("voids the choices when a tab's text changed since the question", async () => {
    const first = await tabsQuestion(site(CLEAN));
    const again = await tabsStage(site("step,answer\n1,Changed.\n"), { challenge: first.challenge, submitted: KEEP });
    expect(again).toMatchObject({ kind: "needs_choices", notice: "sheets_changed" });
  });

  it("voids the choices when the sheet lists different tabs, even a tab whose file the build does not convert", async () => {
    const files = { [`${DIR}/old.csv`]: BOTH_HOLD, [`${DIR}/objects.csv`]: "object_id\n" };
    const first = await tabsQuestion({ files, tabs: [tab("my-story", CLEAN, "7")] });
    const again = await tabsStage(
      { files, tabs: [tab("my-story", CLEAN, "7"), tab("Objetos", "object_id\n")] },
      { challenge: first.challenge, submitted: KEEP },
    );
    expect(again).toMatchObject({ kind: "needs_choices", notice: "sheets_changed" });
  });
});

describe("the offer to stop reading Google Sheets", () => {
  const REFUSED = tab("my-story", EMPTY_DUPLICATE, "7");

  async function offer(site: SheetsSite, extra: Partial<SheetStageInput> = {}) {
    const result = await tabsStage(site, extra);
    if (result.kind !== "needs_sheets_decision") throw new Error(result.kind);
    return result;
  }

  /** The stage's answer once the author accepts the offer. */
  async function accepted(site: SheetsSite, extra: Partial<SheetStageInput> = {}): Promise<SheetStageResult> {
    const asked = await offer(site, extra);
    return tabsStage(site, { ...extra, challenge: asked.challenge, sheetsAnswer: "off" });
  }

  async function switched(site: SheetsSite, extra: Partial<SheetStageInput> = {}) {
    const result = await accepted(site, extra);
    if (result.kind !== "ready") throw new Error(JSON.stringify(result));
    return result;
  }

  const written = (result: { writes: { path: string; content: string }[] }) =>
    Object.fromEntries(result.writes.map((w) => [w.path.slice(DIR.length + 1), w.content]));

  it("is made where a tab would be refused, naming the tabs and columns, bound to the tabs read and asking about no column", async () => {
    const asked = await offer({ files: {}, tabs: [REFUSED] });
    expect(asked.notice).toBeNull();
    expect(asked.detail).toEqual({ tabs: "my-story", count: 1, collisions: [{ tab: "my-story", columns: ["note", "Note"] }] });
    expect(asked.challenge).toMatchObject({ tabs: [{ name: "my-story", gid: "7" }], decisions: { sheets: null, rounds: [] }, pending: [] });
  });

  it("stops the upgrade with sheets_columns_refused when declined", async () => {
    const asked = await offer({ files: {}, tabs: [REFUSED] });
    const result = await tabsStage({ files: {}, tabs: [REFUSED] }, { challenge: asked.challenge, sheetsAnswer: "keep" });
    expect(result).toEqual({ kind: "failed", error: "sheets_columns_refused", detail: asked.detail });
  });

  it("is made again when the answer names neither choice", async () => {
    const asked = await offer({ files: {}, tabs: [REFUSED] });
    expect(await tabsStage({ files: {}, tabs: [REFUSED] }, { challenge: asked.challenge, sheetsAnswer: "maybe" })).toMatchObject({
      kind: "needs_sheets_decision",
    });
  });

  it("writes the tabs as the site's CSVs, repaired, switches _config.yml off, and leaves the recorded head alone", async () => {
    const result = await switched({ files: { [`${DIR}/my-story.csv`]: CLEAN, [`${DIR}/old.csv`]: CLEAN }, tabs: [REFUSED, tab("Second", CLEAN)] });
    expect(written(result)).toEqual({ "my-story.csv": "step,answer,Note\n1,Here.,x\n", "second.csv": CLEAN });
    expect(result.writes.every((w) => w.verbatim === true)).toBe(true);
    expect(result.report).toMatchObject([{ kind: "dropped", file: `${DIR}/my-story.csv`, column: "note", keeper: "Note" }]);
    expect(result.sheetsOff).toEqual({ config: sheetsConfig("false"), written: [`${DIR}/my-story.csv`, `${DIR}/second.csv`], deleted: [] });
    expect(result.decisions).toEqual({ sheets: "off", rounds: [] });
    expect(result).toMatchObject({ tabsChecked: false, advancesHead: false });
    expect(result.finalSheets.map((s) => [s.name, s.text])).toEqual([
      ["my-story.csv", "step,answer,Note\n1,Here.,x\n"],
      ["old.csv", CLEAN],
      ["second.csv", CLEAN],
    ]);
  });

  it.each(["yes", "on", "True", '"True"'])("switches enabled: %s off", async (enabled) => {
    const result = await switched({ files: {}, config: sheetsConfig(enabled), tabs: [REFUSED] });
    expect(result.sheetsOff?.config).toBe(sheetsConfig("false"));
    expect(isGoogleSheetsOn(result.sheetsOff?.config ?? "")).toBe(false);
  });

  it("stops with sheets_switch_unreadable where no edit turns _config.yml off, as with a quoted True in a flow mapping", async () => {
    const config = `google_sheets: {enabled: "True", published_url: "${PUB}"}\n`;
    expect(await accepted({ files: {}, config, tabs: [REFUSED] })).toEqual({ kind: "failed", error: "sheets_switch_unreadable" });
  });

  it("writes proyecto, objetos and glosario tabs as the English files, deleting the Spanish repository copies", async () => {
    const result = await switched({
      files: {
        [`${DIR}/proyecto.csv`]: "order,story_id\n1,old\n",
        [`${DIR}/objetos.csv`]: "object_id\nold\n",
        [`${DIR}/glosario.csv`]: "term_id\nold\n",
      },
      tabs: [tab("Proyecto", "order,story_id\n1,my-story\n"), tab("Objetos", "object_id\nnew\n"), tab("Glosario", "term_id\nnew\n"), REFUSED],
    });
    expect(written(result)).toEqual({
      "project.csv": "order,story_id\n1,my-story\n",
      "objects.csv": "object_id\nnew\n",
      "glossary.csv": "term_id\nnew\n",
      "my-story.csv": "step,answer,Note\n1,Here.,x\n",
    });
    expect(result.sheetsOff?.deleted).toEqual([`${DIR}/proyecto.csv`, `${DIR}/objetos.csv`, `${DIR}/glosario.csv`]);
    expect(result.finalSheets.map((s) => [s.name, s.role])).toEqual([
      ["glossary.csv", "glossary"],
      ["my-story.csv", "story"],
      ["objects.csv", "objects"],
      ["project.csv", "project"],
    ]);
  });

  it("leaves an objetos tab unwritten beside the repository's objects.csv, which the build reads", async () => {
    const result = await switched({ files: { [`${DIR}/objects.csv`]: "object_id\nrepo\n" }, tabs: [tab("Objetos", "object_id\ntab\n"), REFUSED] });
    expect(Object.keys(written(result))).toEqual(["my-story.csv"]);
    expect(result.sheetsOff?.deleted).toEqual([]);
  });

  it("writes an objetos tab with no English file as objects.csv, deleting the repository's objetos.csv", async () => {
    const result = await switched({ files: { [`${DIR}/objetos.csv`]: "object_id\nrepo\n" }, tabs: [tab("Objetos", "object_id\ntab\n"), REFUSED] });
    expect(written(result)["objects.csv"]).toBe("object_id\ntab\n");
    expect(result.sheetsOff?.deleted).toEqual([`${DIR}/objetos.csv`]);
  });

  it("writes a project tab over the manifest chain's edit of project.csv", async () => {
    const result = await switched(
      { files: { [`${DIR}/project.csv`]: "order,story_id\n1,s\n" }, tabs: [tab("project", "order,story_id\n1,from-tab\n"), REFUSED] },
      { chainFiles: new Map([["_config.yml", ON], [`${DIR}/project.csv`, "order,story_id,added\n1,s,\n"]]) },
    );
    expect(written(result)["project.csv"]).toBe("order,story_id\n1,from-tab\n");
    expect(result.finalSheets.find((sheet) => sheet.name === "project.csv")?.text).toBe("order,story_id\n1,from-tab\n");
  });

  it("asks about columns a written tab holds values in, carrying the decision, and replays both", async () => {
    const site = { files: {}, tabs: [tab("my-story", BOTH_HOLD, "7")] };
    const asked = await accepted(site);
    if (asked.kind !== "needs_choices") throw new Error(asked.kind);
    expect(asked.challenge.decisions).toEqual({ sheets: "off", rounds: [] });
    const choice = [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }];
    const result = await tabsStage(site, { challenge: asked.challenge, submitted: choice });
    if (result.kind !== "ready") throw new Error(result.kind);
    expect(written(result)).toEqual({ "my-story.csv": "step,answer,Note\n1,Here.,b\n" });
    expect(result.decisions).toEqual({ sheets: "off", rounds: [{ choices: choice }] });
    expect(result.sheetsOff?.written).toEqual([`${DIR}/my-story.csv`]);
  });

  it.each([
    ["a tab's text changed", { tabs: [tab("my-story", "step,answer,note,Note\n1,Changed.,,x\n", "7")] }, {}],
    ["the head moved", {}, { headOid: "head-2" }],
  ])("is void, and made again, when %s", async (_label, change, extra) => {
    const site: SheetsSite = { files: {}, tabs: [REFUSED] };
    const asked = await offer(site);
    const again = await tabsStage({ ...site, ...change }, { ...extra, challenge: asked.challenge, sheetsAnswer: "off" });
    expect(again).toMatchObject({ kind: "needs_sheets_decision", notice: "sheets_changed" });
  });
});
