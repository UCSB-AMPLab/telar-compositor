/**
 * The kinds a glossary entry can be, as the site's own files give them. The
 * Compositor reads the list and defines none of it: the core kinds come from
 * `_data/glossary_kinds.yml`, their labels from the site's language file, and
 * the site's own kinds from `glossary: kinds:` in `_config.yml`. A site older
 * than the kinds has no `_data/glossary_kinds.yml`, and then there is no list.
 *
 * A value is matched as the framework matches it (scripts/telar/glossary_kinds.py):
 * with case, accents, underscores, hyphens and repeated spaces folded away,
 * against a kind's id and its `values`. A site kind is accepted on the
 * framework's terms: it needs a label and a heading, and none of its id or
 * values may already belong to an earlier kind.
 *
 * @version v1.5.1-beta
 */
import { load } from "js-yaml";

export interface GlossaryKindOption {
  id: string;
  /** What the site shows for the kind: its language key's text, or the label as the config writes it. */
  label: string;
  /** Every folded value that names the kind, its id included. */
  aliases: string[];
  /** A core kind's glossary callout icon, as `_data/glossary_kinds.yml` names it; a site kind has none. */
  icon?: string;
}

/** A site kind as it is stored and published: its text trimmed, its values as the framework reads them. */
export interface SiteKind {
  id: string;
  label: string;
  heading: string;
  values: string[];
}

/** Why a site kind is left out, as a `glossary` language key and its values. */
export interface KindProblem {
  key:
    | "kind_error_id_required"
    | "kind_error_label_required"
    | "kind_error_heading_required"
    | "kind_error_values_not_list"
    | "kind_error_id_taken"
    | "kind_error_value_taken";
  /** The id or value another kind already has, as written. */
  value?: string;
  /** The label of the kind that has it. */
  kind?: string;
  /** The id of the kind that has it, when that is a standard kind, so it can be named in the interface language. */
  standardKind?: string;
}

export type SiteKindProblems = Partial<Record<keyof SiteKind, KindProblem>>;

/** A site kind as written, accepted or not, with what keeps it out. */
export interface SiteKindDraft extends SiteKind {
  problems: SiteKindProblems;
}

export interface GlossaryKinds {
  /** False when the site has no kinds to choose from. */
  available: boolean;
  /** The core kinds in page order, then the site's accepted ones in order. */
  options: GlossaryKindOption[];
  /** The kind a blank or unrecognised value is read as. */
  defaultId: string;
  /** The core kinds alone. */
  core: GlossaryKindOption[];
  /** Every site kind as written, accepted or not. */
  site: SiteKindDraft[];
  /** The config's site kinds in their stored form, as this read found them. */
  repoSite?: string;
  /** Set when `_config.yml` could not be fetched, so the config's site kinds are unknown. */
  configInconclusive?: true;
}

export const NO_GLOSSARY_KINDS: GlossaryKinds = { available: false, options: [], defaultId: "term", core: [], site: [] };

/**
 * Whether a character has a canonical combining class other than 0, which is
 * what Python's `unicodedata.combining` answers. A mark of class 0 (a Devanagari
 * vowel sign, say) stays. Canonical ordering moves a mark of class above 1 past
 * U+0334 (class 1), and a mark of class 1 to 239 past U+0345 (class 240).
 */
function isCombining(ch: string): boolean {
  if (!/\p{M}/u.test(ch)) return false;
  return `${ch}\u0334`.normalize("NFD") !== `${ch}\u0334` || `\u0345${ch}`.normalize("NFD") !== `\u0345${ch}`;
}

/**
 * Python's `str.casefold`. Upper-casing before lower-casing takes `ß` and `ﬁ`
 * to `ss` and `fi`, which `toLowerCase` alone leaves as they are; what remains
 * is the three places the two part: a final sigma stays `σ`, `ẞ` is `ss`, and
 * Cherokee folds to its capitals.
 */
function casefold(value: string): string {
  return value
    .toUpperCase()
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/ß/g, "ss")
    .replace(/[\uab70-\uabbf\u13f8-\u13fd]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return String.fromCharCode(code >= 0xab70 ? code - 0xab70 + 0x13a0 : code - 8);
    });
}

/** A value without its accents, as `unicodedata.normalize('NFKD')` less its combining marks leaves it. */
function withoutAccents(value: string): string {
  return [...value.normalize("NFKD")].filter((ch) => !isCombining(ch)).join("");
}

/** A value with case and accents folded away, word separators kept. */
export function foldCaseAndAccents(value: string): string {
  return casefold(withoutAccents(value));
}

/** A value with case, accents and word separators folded away, as the framework's `_fold` folds it. */
export function foldKindValue(value: string): string {
  return casefold(withoutAccents(value).replace(/[\s\x1c-\x1f_-]+/g, " ").trim());
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A `section.key` language path read from a parsed language file. */
function langString(lang: unknown, path: unknown): string {
  const [section, key] = text(path).split(".");
  const group = isRecord(lang) && section ? lang[section] : undefined;
  return isRecord(group) ? text(group[key]) : "";
}

/** A scalar the framework accepts as a kind value, as Python's `str()` writes it (a YAML boolean is an int there). */
function isKindScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function pythonStr(v: string | number | boolean): string {
  return typeof v === "boolean" ? (v ? "True" : "False") : String(v);
}

/** The values a kind lists: none when `values` is absent or null, undefined when it is not a list of scalars. */
function valuesOf(values: unknown): string[] | undefined {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || !values.every(isKindScalar)) return undefined;
  return values.map(pythonStr);
}

function aliasesOf(id: string, values: string[]): string[] {
  return [id, ...values].map(foldKindValue);
}

/** The `glossary: kinds:` entries of a config, none when it does not parse. */
function configuredKinds(configYaml: string | null): unknown[] {
  try {
    const config = configYaml ? load(configYaml) : null;
    const glossary = isRecord(config) ? config.glossary : null;
    return isRecord(glossary) ? list(glossary.kinds) : [];
  } catch {
    return [];
  }
}

/** A site kind's fields as the framework reads them; an entry that is not a mapping has none. */
export function toSiteKind(entry: unknown): SiteKind {
  const e = isRecord(entry) ? entry : {};
  return { id: text(e.id), label: text(e.label), heading: text(e.heading), values: valuesOf(e.values) ?? valuesText(e.values) };
}

/** A value as text the author can read; empty for one JSON cannot write, such as a list that holds itself. */
function valueText(v: unknown): string {
  if (isKindScalar(v)) return pythonStr(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** `values` that are not a list of scalars, kept as text the author can see and correct. */
function valuesText(values: unknown): string[] {
  return Array.isArray(values) ? values.map(valueText) : [valueText(values)];
}

/** What the framework finds missing or malformed in a kind's own fields. */
function fieldProblems(entry: unknown): SiteKindProblems {
  const kind = toSiteKind(entry);
  const problems: SiteKindProblems = {};
  if (!kind.id) problems.id = { key: "kind_error_id_required" };
  if (!kind.label) problems.label = { key: "kind_error_label_required" };
  if (!kind.heading) problems.heading = { key: "kind_error_heading_required" };
  if (isRecord(entry) && !valuesOf(entry.values)) problems.values = { key: "kind_error_values_not_list" };
  return problems;
}

/** The kind's id, else the first of its values, that an earlier kind owns; the framework stops at the first. */
interface Owner {
  label: string;
  standardKind?: string;
}

function takenProblems(kind: SiteKind, taken: Map<string, Owner>): SiteKindProblems {
  const owner = (value: string) => taken.get(foldKindValue(value));
  const idOwner = kind.id ? owner(kind.id) : undefined;
  if (idOwner !== undefined) {
    return { id: { key: "kind_error_id_taken", value: kind.id, kind: idOwner.label, standardKind: idOwner.standardKind } };
  }
  const value = kind.values.find((v) => owner(v) !== undefined);
  const valueOwner = value === undefined ? undefined : owner(value);
  return value === undefined || !valueOwner
    ? {}
    : { values: { key: "kind_error_value_taken", value, kind: valueOwner.label, standardKind: valueOwner.standardKind } };
}

export const isAcceptedKind = (problems: SiteKindProblems): boolean => Object.keys(problems).length === 0;

/**
 * Why each site kind in `list` would be left out, in list order, beside the
 * core kinds: an empty record for a kind the framework accepts. A kind's id
 * and values are taken only once it is accepted, so an earlier kind keeps a
 * value against a later one, and a rejected kind takes nothing from those
 * after it.
 */
export function validateSiteKinds(core: GlossaryKindOption[], list: unknown[]): SiteKindProblems[] {
  const taken = new Map<string, Owner>();
  const claim = (aliases: string[], owner: Owner) => aliases.forEach((a) => taken.set(a, owner));
  core.forEach((o) => claim(o.aliases, { label: o.label, standardKind: o.id }));
  return list.map((entry) => {
    const kind = toSiteKind(entry);
    const problems = { ...takenProblems(kind, taken), ...fieldProblems(entry) };
    if (isAcceptedKind(problems)) claim(aliasesOf(kind.id, kind.values), { label: kind.label });
    return problems;
  });
}

/** A kind as stored: `toSiteKind`'s fields, with `values` that are not a list of scalars kept as one text, so the malformation survives. */
function storedKind(entry: unknown): Omit<SiteKind, "values"> & { values: string[] | string } {
  const kind = toSiteKind(entry);
  const raw = isRecord(entry) ? entry.values : undefined;
  return valuesOf(raw) ? kind : { ...kind, values: valueText(raw) };
}

/** The stored form of a list of site kinds: each kind's four fields, in a fixed order. */
export function serializeSiteKinds(list: unknown[]): string {
  return JSON.stringify(list.map(storedKind));
}

/**
 * The site kinds a stored column holds, or null when the config is their
 * source: the column is null, or holds something other than a JSON list,
 * which no save writes.
 */
export function storedSiteKinds(stored: string | null | undefined): unknown[] | null {
  if (stored === null || stored === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `kinds` with `list` as the site's own kinds, in place of the ones it had. */
export function withSiteKinds(kinds: GlossaryKinds, list: unknown[]): GlossaryKinds {
  if (!kinds.available) return kinds;
  const problems = validateSiteKinds(kinds.core, list);
  const site = list.map((entry, i) => ({ ...toSiteKind(entry), problems: problems[i] }));
  const accepted = site
    .filter((kind) => isAcceptedKind(kind.problems))
    .map((kind) => ({ id: kind.id, label: kind.label, aliases: aliasesOf(kind.id, kind.values) }));
  return { ...kinds, options: [...kinds.core, ...accepted], site };
}

/** A core kind from its entry in `_data/glossary_kinds.yml`, labelled from the language file. */
function coreKind(entry: unknown, lang: unknown): GlossaryKindOption | null {
  if (!isRecord(entry) || !text(entry.id)) return null;
  const id = text(entry.id);
  const values = valuesOf(entry.values) ?? [];
  const label = langString(lang, entry.panel_label) || text(entry.panel_label);
  const icon = text(entry.icon);
  return { id, label, aliases: aliasesOf(id, values), ...(icon ? { icon } : {}) };
}

/** The list for a site's three files; none when the core kinds file is missing or unreadable. */
export function parseGlossaryKinds(
  kindsYaml: string | null,
  configYaml: string | null,
  langYaml: string | null,
): GlossaryKinds {
  try {
    const core = kindsYaml ? load(kindsYaml) : null;
    if (!Array.isArray(core)) return NO_GLOSSARY_KINDS;
    const lang = langYaml ? load(langYaml) : null;
    const options = core.map((entry) => coreKind(entry, lang)).filter((kind): kind is GlossaryKindOption => kind !== null);
    if (options.length === 0) return NO_GLOSSARY_KINDS;
    const defaultEntry = core.find((entry) => isRecord(entry) && entry.default === true);
    const defaultId = isRecord(defaultEntry) ? text(defaultEntry.id) : "term";
    const site = configuredKinds(configYaml);
    const coreOnly: GlossaryKinds = { available: true, options, defaultId, core: options, site: [], repoSite: serializeSiteKinds(site) };
    return withSiteKinds(coreOnly, site);
  } catch {
    return NO_GLOSSARY_KINDS;
  }
}

/** The kind a stored value names, or undefined when it names none (a blank names the default). */
export function kindOfValue(kinds: GlossaryKinds, value: string): GlossaryKindOption | undefined {
  const folded = foldKindValue(value);
  const wanted = folded === "" ? kinds.defaultId : folded;
  return kinds.options.find((o) => o.id === wanted || o.aliases.includes(wanted));
}

/** The kind the site reads a stored value as: its own, else the default. */
export function readKind(kinds: GlossaryKinds, value: string): GlossaryKindOption | undefined {
  return kindOfValue(kinds, value) ?? kinds.options.find((o) => o.id === kinds.defaultId);
}

/** What the site shows for an entry's stored kind, or undefined where the site offers no kinds. */
export function kindLabelOf(kinds: GlossaryKinds, value: string): string | undefined {
  return kinds.available ? readKind(kinds, value)?.label : undefined;
}

/**
 * The language file the framework reads for a site: `telar_language` in its
 * `_config.yml`, "en" when it is absent or the config does not parse
 * (scripts/telar/config.py, `load_language_data`). The name is a path
 * component here, so one that could leave `_data/languages/` reads as "en".
 */
export function siteLanguage(configYaml: string | null): string {
  try {
    const config = configYaml ? load(configYaml) : null;
    const language = isRecord(config) && "telar_language" in config ? config.telar_language : "en";
    const name = typeof language === "string" ? language : String(language);
    return /^[\w][\w.-]*$/.test(name) && !name.includes("..") ? name : "en";
  } catch {
    return "en";
  }
}
