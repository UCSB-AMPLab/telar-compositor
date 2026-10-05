/**
 * Every key the code asks for is in the English catalogue.
 *
 * A `t("key")` whose key is missing renders the key's own name, or its English
 * `defaultValue` in every language, and no other test fails: parity compares
 * the two locales with each other, and the catalogue scan looks for keys
 * nothing asks for. The lookup rules are in `helpers/code-key-scan.ts`.
 *
 * A reference that does not resolve today is on `MISSING_BASELINE` with the
 * reason it is there. The list can only shrink: a new miss fails, and so does
 * an entry that now resolves.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  loadEnglishCatalogue,
  resolves,
  scanRepository,
  scanSource,
  type Catalogue,
} from "./helpers/code-key-scan";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogue = loadEnglishCatalogue(repoRoot);
const scan = scanRepository(repoRoot, catalogue);

/**
 * Keys the code asks for that the catalogue lacks today, as `file ns:key`.
 * Each renders its English `defaultValue` in both languages until its strings
 * are written and approved.
 */
const MISSING_BASELINE: Record<string, string> = {};

const referenceId = (ref: { file: string; key: string; namespaces: string[] | null }) =>
  `${ref.file} ${ref.namespaces ? ref.namespaces[0] : "*"}:${ref.key}`;

describe("code → catalogue", () => {
  it("reads enough of the code to mean something", () => {
    expect(scan.references.length).toBeGreaterThan(1000);
  });

  it("asks for no key the catalogue lacks, beyond the baseline", () => {
    const missing = scan.references.filter((ref) => !resolves(catalogue, ref)).map(referenceId);
    const unexpected = missing.filter((id) => !(id in MISSING_BASELINE));
    expect(unexpected, "keys the code asks for that app/i18n/locales/en does not hold").toEqual([]);
  });

  it("carries no baseline entry that now resolves or is no longer asked for", () => {
    const missing = new Set(scan.references.filter((ref) => !resolves(catalogue, ref)).map(referenceId));
    const stale = Object.keys(MISSING_BASELINE).filter((id) => !missing.has(id));
    expect(stale).toEqual([]);
  });
});

describe("code → catalogue: lookup rules", () => {
  const fixture: Catalogue = new Map([
    ["common", new Set(["save", "items_one", "items_other", "menu.open", "menu.close"])],
    ["editor", new Set(["title"])],
    ["account", new Set(["prefs.label"])],
  ]);
  const known = new Set(fixture.keys());
  const refsOf = (text: string) => scanSource("fixture.tsx", text, known).references;
  const resolvesAll = (text: string) => refsOf(text).map((ref) => resolves(fixture, ref));

  it("looks a key up in the namespace its scope's useTranslation names", () => {
    expect(resolvesAll(`function Fixture1(){ const { t } = useTranslation("editor"); t("title"); t("save"); }`)).toEqual([
      true,
      false,
    ]);
  });

  it("keeps one component's binding from answering for another's", () => {
    const text = `
      function Fixture2(){ const { t } = useTranslation("editor"); return t("title"); }
      function FixtureOther(){ const { t } = useTranslation("account"); return t("title"); }`;
    expect(resolvesAll(text)).toEqual([true, false]);
  });

  it("follows an alias, the default namespace, and an ns: prefix", () => {
    const text = `function Fixture3(){
      const { t: tEditor } = useTranslation("editor");
      const { t } = useTranslation();
      tEditor("title"); t("save"); t("account:prefs.label");
    }`;
    expect(resolvesAll(text)).toEqual([true, true, true]);
  });

  it("honours an ns option on the call", () => {
    const text = `function Fixture4(){ const { t } = useTranslation(["editor", "account"]); t("prefs.label", { ns: "account" }); t("prefs.label"); }`;
    expect(resolvesAll(text)).toEqual([true, false]);
  });

  it("resolves plural forms and subtrees", () => {
    const text = `function Fixture5(){ const { t } = useTranslation("common"); t("items", { count: 2 }); t("menu", { returnObjects: true }); }`;
    expect(resolvesAll(text)).toEqual([true, true]);
  });

  it("looks everywhere for a t it cannot trace, and catches a key that is nowhere", () => {
    const text = `function Fixture6({ t }){ t("title"); t("nowhere_at_all"); }`;
    expect(resolvesAll(text)).toEqual([true, false]);
  });

  it("reads a Trans i18nKey, with its ns attribute when it has one", () => {
    const text = `function Fixture7(){ return <><Trans i18nKey="prefs.label" ns="account" /><Trans i18nKey="missing_key" /></>; }`;
    expect(resolvesAll(text)).toEqual([true, false]);
  });

  it("resolves a plural only with count and both English forms, and a subtree only with returnObjects", () => {
    const partial: Catalogue = new Map([["common", new Set(["meta_one", "items_one", "items_other", "menu.open"])]]);
    const text = `function FixtureP(){ const { t } = useTranslation("common");
      t("items"); t("items", { count: 2 }); t("meta", { count: 2 }); t("menu"); t("menu", { returnObjects: true }); }`;
    const refs = scanSource("fixture.tsx", text, new Set(partial.keys())).references;
    expect(refs.map((ref) => resolves(partial, ref))).toEqual([false, true, false, false, true]);
  });

  it("reads a Trans in the default namespace, or the namespace of the t it is handed", () => {
    const text = `function FixtureT(){ const { t } = useTranslation("editor");
      return <><Trans i18nKey="title" /><Trans t={t} i18nKey="title" /><Trans i18nKey={"save"} /><Trans i18nKey="prefs.label" ns={"account"} /></>; }`;
    expect(resolvesAll(text)).toEqual([false, true, true, true]);
  });

  it("puts a keyPrefix in front of the key", () => {
    const text = `function FixtureK(){ const { t } = useTranslation("account", { keyPrefix: "prefs" }); t("label"); t("prefs.label"); }`;
    expect(resolvesAll(text)).toEqual([true, false]);
  });

  it("reads an ns option as an array, as a quoted key, and after a default value", () => {
    const text = `function FixtureN(){ const { t } = useTranslation("common");
      t("title", { ns: ["common", "editor"] }); t("title", { "ns": "editor" }); t("prefs.label", "Label", { ns: "account" }); }`;
    expect(resolvesAll(text)).toEqual([true, true, true]);
  });

  it("lets a closer parameter shadow an outer binding", () => {
    const text = `function FixtureS(){ const { t } = useTranslation("editor");
      function Child({ t }) { return t("save"); }
      return t("save"); }`;
    expect(resolvesAll(text)).toEqual([true, false]);
  });

  it("follows a binding under any name, and reads i18n.t in the default namespace", () => {
    const text = `function FixtureR(){ const { t: translate } = useTranslation("editor");
      translate("title"); translate("save"); i18n.t("save"); i18n.t("title"); }`;
    expect(resolvesAll(text)).toEqual([true, false, true, false]);
  });

  it("reads options it cannot see as allowing any namespace and any form", () => {
    const text = `function FixtureV(){ const { t } = useTranslation("editor");
      t("prefs.label", opts); t("items", { ...opts }); t("menu", "Menu", opts); t("nowhere_at_all", opts); }`;
    expect(resolvesAll(text)).toEqual([true, true, true, false]);
  });

  it("needs only the plural form a written count picks", () => {
    const partial: Catalogue = new Map([["common", new Set(["one_one", "many_other"])]]);
    const text = `function FixtureC(){ const { t } = useTranslation("common");
      t("one", { count: 1 }); t("many", { count: 5 }); t("one", { count: 5 }); t("many", { count: n }); }`;
    const refs = scanSource("fixture.tsx", text, new Set(partial.keys())).references;
    expect(refs.map((ref) => resolves(partial, ref))).toEqual([true, true, false, false]);
  });

  it("lets a context or ordinal option answer with a suffixed leaf", () => {
    const suffixed: Catalogue = new Map([["common", new Set(["role_owner", "place_ordinal_one"])]]);
    const text = `function FixtureX(){ const { t } = useTranslation("common");
      t("role", { context: kind }); t("place", { count: n, ordinal: true }); t("role"); }`;
    const refs = scanSource("fixture.tsx", text, new Set(suffixed.keys())).references;
    expect(refs.map((ref) => resolves(suffixed, ref))).toEqual([true, true, false]);
  });

  it("takes a key under a keyPrefix with or without it when the call names a namespace", () => {
    const text = `function FixtureKN(){ const { t } = useTranslation("editor", { keyPrefix: "prefs" });
      t("label", { ns: "account" }); t("account:label"); t("prefs.label", { ns: "account" }); t("label", { ns: "common" }); }`;
    expect(resolvesAll(text)).toEqual([true, true, true, false]);
  });

  it("searches every namespace of the list under nsMode fallback", () => {
    const text = `function FixtureF(){ const { t } = useTranslation(["editor", "account"], { nsMode: "fallback" });
      t("title"); t("prefs.label"); t("save"); }`;
    expect(resolvesAll(text)).toEqual([true, true, false]);
  });

  it("lets a loop, catch or function name shadow an outer binding", () => {
    const text = `function FixtureL(){ const { t } = useTranslation("editor");
      for (const t of fns) t("save");
      try { run(); } catch (t) { t("save"); }
      { function t(x) { return x; } t("save"); }
      return t("save"); }`;
    expect(resolvesAll(text)).toEqual([true, true, true, false]);
  });

  it("picks the plural form English picks for a written count, and takes _zero for 0", () => {
    const partial: Catalogue = new Map([["common", new Set(["none_zero", "back_one", "files_one"])]]);
    const text = `function FixtureZ(){ const { t } = useTranslation("common");
      t("none", { count: 0 }); t("back", { count: -1 }); t("back", { count: 0 });
      return <Trans i18nKey="files" count={1} />; }`;
    const refs = scanSource("fixture.tsx", text, new Set(partial.keys())).references;
    expect(refs.map((ref) => resolves(partial, ref))).toEqual([true, true, false, true]);
  });

  it("lets a call's keyPrefix option replace the binding's", () => {
    const text = `function FixtureKP(){ const { t } = useTranslation("common", { keyPrefix: "prefs" });
      t("save", { keyPrefix: "" }); t("open", { keyPrefix: "menu" }); t("save"); t("open", { keyPrefix: p }); }`;
    expect(resolvesAll(text)).toEqual([true, true, false, true]);
  });

  it("ignores a keyPrefix option on i18n.t, and keeps an untraced t's namespace open", () => {
    const text = `function FixtureKD({ t }){ i18n.t("save", { keyPrefix: "menu" });
      t("title", { keyPrefix: "" }); t("open", { keyPrefix: "menu" }); t("label", { keyPrefix: "prefs" }); }`;
    expect(resolvesAll(text)).toEqual([true, true, true, true]);
  });

  it("lets options it cannot read put the key under any prefix", () => {
    const text = `function FixtureKU(){ const { t } = useTranslation("account", { keyPrefix: "other" });
      t("label", opts); t("absent", opts); }`;
    expect(resolvesAll(text)).toEqual([true, false]);
  });

  it("takes each plural form from whichever namespace of the list holds it", () => {
    const split: Catalogue = new Map([
      ["editor", new Set(["items_one"])],
      ["account", new Set(["items_other"])],
    ]);
    const text = `function FixtureFP(){ const { t } = useTranslation(["editor", "account"], { nsMode: "fallback" });
      t("items", { count: n }); }`;
    const refs = scanSource("fixture.tsx", text, new Set(split.keys())).references;
    expect(refs.map((ref) => resolves(split, ref))).toEqual([true]);
  });

  it("counts a key built at runtime rather than guessing it", () => {
    const result = scanSource("f.tsx", "function Fixture8(){ const { t } = useTranslation(); t(`x.${k}`); t(key); }", known);
    expect(result.references).toEqual([]);
    expect(result.dynamic).toBe(2);
  });
});
