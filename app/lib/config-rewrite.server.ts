/**
 * The rewrite of a `_config.yml` the publish writer cannot update: the file is
 * rebuilt from the Telar release's template, with the site's own settings
 * copied into it, and the Site settings written over that.
 *
 * The publish page offers it on the `config_needs_rewrite` blocker. The author
 * reviews the report of what the rewrite keeps, replaces and removes, and the
 * fingerprint of the rebuilt text travels with their publish; the publish
 * rebuilds once, and writes the text only when its fingerprint is the one the
 * author reviewed.
 *
 * How the file is rebuilt:
 *
 * 1. Template: the `_config.yml` of the site's own release, or of the latest
 *    release when the site has no stored version or its tag has no such file.
 * 2. Documents and entries: a `---` or `...` line after the first entry ends
 *    the first document, and nothing after it is read. The file is split into
 *    top-level entries, each from a column-0 plain `key:` line to the line
 *    before the next one, with the blank lines and column-0 comments directly
 *    above a key belonging to the entry below. Lines above the first key are
 *    the header.
 * 3. Reading: each site entry is parsed alone under the core schema; one that
 *    does not parse to its own key is removed. A repeated key keeps its last
 *    readable occurrence, as the framework's reader does.
 * 4. Assembling: the template's header, then each template entry, replaced by
 *    the site's entry for the same key; then the site's entries whose key the
 *    template lacks, in their order. Entries are copied verbatim, except a
 *    managed field the Site settings write, written as the writer writes it,
 *    and a managed block in a shape its writer cannot edit, written as an
 *    indented block from its parsed value.
 * 5. Settings: the Site settings go in through the publish writer
 *    (`publishableConfigYaml`).
 * 6. Commit clean: the text is cleaned as a commit cleans it
 *    (`cleanCommitContent`), so what is checked, hashed and committed is one
 *    text, and the file set commits it verbatim.
 * 7. Self-check: every key read from the site holds the same value in the
 *    result, except what the Site settings write and the writer's one
 *    normalisation (`telar.version` without a leading `v`). A result that
 *    fails is never offered.
 *
 * The report is read from the final text, not from the classification above,
 * except for the removed lines, which are absent from the final text.
 *
 * @version v1.5.5-beta
 */

import { eq } from "drizzle-orm";
import { project_config } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { cleanCommitContent } from "~/lib/commit.server";
import { canWriteConfigField } from "~/lib/config-fields";
import { canonicalKindsJson, repoGlossaryKindsJson, writeGlossaryKinds } from "~/lib/glossary-kinds-yaml.server";
import { escapeYamlString } from "~/lib/knap-filters.server";
import {
  MANAGED_CONFIG_BLOCKS,
  configNeedsRewrite,
  type AcknowledgedConfigRewrite,
  type ValidationItem,
  buildConfigManagedBlocks,
  buildConfigManagedFields,
  publishableConfigYaml,
  unwritableConfigBlocks,
} from "~/lib/publish.server";
import { fetchFrameworkFile, fetchLatestRelease } from "~/lib/upgrade.server";
import { normalizeVersionTag } from "~/lib/version";
import { isYamlMapping, parseYaml, sameYamlValue, yamlMappingWithoutMerges, type YamlMapping } from "~/lib/yaml.server";

type ConfigRow = typeof project_config.$inferSelect;

/** What the rewrite does to the site's file, as the review dialog lists it. */
export interface ConfigRewriteReport {
  /** The release tag of the template the file is rebuilt from. */
  templateTag: string;
  /** Top-level settings from the site's file whose value the result keeps. */
  kept: string[];
  /** Settings whose value the Site settings write over the file's, `block.child` within a managed block. */
  fromSettings: string[];
  /** Settings the site's file lacks, which take the template's value. */
  templateValues: string[];
  /** The site's lines that could not be read, as they were written. */
  removed: string[];
  /** Whether a comment line of the site's file is not in the result. */
  commentsDropped: boolean;
}

export interface RebuiltConfig {
  text: string;
  report: ConfigRewriteReport;
}

/** The template a rewrite is built from. */
export interface ConfigTemplate {
  tag: string;
  text: string;
}

export type ConfigRewritePreparation =
  | { kind: "ready"; text: string; report: ConfigRewriteReport; fingerprint: string }
  | { kind: "template_unavailable" }
  | { kind: "failed" };

/** A column-0 plain `key:` line, the key optionally spaced from its colon, which opens a top-level entry. */
const PLAIN_KEY = /^([A-Za-z0-9_][\w-]*)[ \t]*:([ \t]|$)/;

/** A line that ends a YAML document. */
const DOCUMENT_MARKER = /^(---|\.\.\.)([ \t].*)?$/;

/** A line carrying nothing but whitespace or a comment. */
const BLANK_OR_COMMENT = /^[ \t]*(#.*)?$/;

/** Whether `key` is a managed block, the glossary among them, whose shape a writer depends on. */
function isBlockKey(key: string): boolean {
  return key === "glossary" || (MANAGED_CONFIG_BLOCKS as readonly string[]).includes(key);
}

interface Entry {
  key: string;
  lines: string[];
  /** Position among the file's entries. */
  at: number;
}

interface SplitConfig {
  /** The lines of the first document, which is all that is read. */
  document: string[];
  header: string[];
  entries: Entry[];
  /** The lines from the end of the first document on, which are never read. */
  after: string[];
}

/** `text` split into its header, top-level entries and the lines after the first document. */
function splitConfig(text: string): SplitConfig {
  const all = text.replace(/^﻿/, "").split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const first = all.findIndex((line) => PLAIN_KEY.test(line));
  if (first === -1) return { document: all, header: all, entries: [], after: [] };
  const marker = all.findIndex((line, i) => i > first && DOCUMENT_MARKER.test(line));
  const end = marker === -1 ? all.length : marker;
  const keyLines: number[] = [];
  for (let i = first; i < end; i++) if (PLAIN_KEY.test(all[i])) keyLines.push(i);
  const starts = keyLines.map((keyLine, n) => {
    if (n === 0) return keyLine;
    let start = keyLine;
    while (start - 1 > keyLines[n - 1] && /^(#.*)?[ \t]*$/.test(all[start - 1])) start--;
    return start;
  });
  const entries = keyLines.map((keyLine, n) => ({
    key: all[keyLine].match(PLAIN_KEY)![1],
    lines: all.slice(starts[n], n + 1 < starts.length ? starts[n + 1] : end),
    at: n,
  }));
  return { document: all.slice(0, end), header: all.slice(0, first), entries, after: all.slice(end) };
}

/** The lines of `lines` that carry something other than a comment. */
function contentLines(lines: readonly string[]): string[] {
  return lines.filter((line) => !BLANK_OR_COMMENT.test(line)).map((line) => line.trimEnd());
}

/** An entry's value, parsed alone, or undefined when it does not parse to its own key. */
function entryValue(entry: Entry): { value: unknown } | undefined {
  const doc = yamlMappingWithoutMerges(entry.lines.join("\n"));
  if (doc === null) return undefined;
  const keys = Object.keys(doc);
  return keys.length === 1 && keys[0] === entry.key ? { value: doc[entry.key] } : undefined;
}

interface ReadEntry {
  entry: Entry;
  value: unknown;
  /** Read from the whole document, where the entry alone does not parse: written from its value. */
  resolved?: true;
}

/**
 * An entry's value read alone, or, where it does not parse alone (an alias to
 * another entry, say) and the whole document gives its key a value, that value.
 */
function readEntryValue(entry: Entry, whole: YamlMapping | null): Omit<ReadEntry, "entry"> | undefined {
  const parsed = entryValue(entry);
  if (parsed !== undefined) return parsed;
  return whole !== null && Object.hasOwn(whole, entry.key) ? { value: whole[entry.key], resolved: true } : undefined;
}

/** The entries of a split file each key reads from, and the lines nothing reads. */
function readConfig(split: SplitConfig): { read: Map<string, ReadEntry>; removed: string[] } {
  const read = new Map<string, ReadEntry>();
  const removed = contentLines(split.header);
  const whole = yamlMappingWithoutMerges(split.document.join("\n"));
  for (const entry of split.entries) {
    const parsed = readEntryValue(entry, whole);
    if (parsed === undefined) {
      removed.push(...contentLines(entry.lines));
      continue;
    }
    const earlier = read.get(entry.key);
    if (earlier) removed.push(...contentLines(earlier.entry.lines));
    read.delete(entry.key);
    read.set(entry.key, { entry, ...parsed });
  }
  removed.push(...contentLines(split.after));
  return { read, removed };
}

/** A key as a block child: plain where it can be, quoted otherwise. */
function childKey(key: string): string {
  return /^[A-Za-z0-9_][\w-]*$/.test(key) ? key : escapeYamlString(key);
}

/** A number written so the core schema reads it back as the same number. */
function flowNumber(value: number): string {
  if (Number.isNaN(value)) return ".nan";
  if (!Number.isFinite(value)) return value > 0 ? ".inf" : "-.inf";
  return String(value);
}

/** A sequence or mapping written as a flow collection, or null for any other value. */
function flowCollection(value: unknown): string | null {
  if (Array.isArray(value)) return `[${value.map(flowValue).join(", ")}]`;
  if (!isYamlMapping(value)) return null;
  return `{${Object.entries(value).map(([k, v]) => `${escapeYamlString(k)}: ${flowValue(v)}`).join(", ")}}`;
}

/** A parsed value written back as YAML that reads as the same value under the core schema. */
function flowValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return flowNumber(value);
  if (typeof value === "string") return escapeYamlString(value);
  return flowCollection(value) ?? escapeYamlString(String(value));
}

/**
 * Whether the writer of a managed block, or of the glossary kinds, cannot edit
 * this entry. The writers find a block by its `key:` header, so a key spaced
 * from its colon is one they cannot edit.
 */
function blockUnwritable(entry: Entry): boolean {
  if (!entry.lines.some((line) => line.startsWith(`${entry.key}:`))) return true;
  const text = entry.lines.join("\n");
  if (entry.key === "glossary") return writeGlossaryKinds(text, []) === null;
  return unwritableConfigBlocks(text, [entry.key]).length > 0;
}

/**
 * A managed block written as an indented block from its value, with the
 * managed children the Site settings write already holding the values
 * written; the block's other children come through, its comments excepted.
 */
function blockLines(key: string, value: unknown, writes: Record<string, string>): string[] {
  if (isYamlMapping(value) && Object.keys(value).length === 0 && Object.keys(writes).length === 0) {
    return [`${key}: {}`];
  }
  const children: Record<string, string> = {};
  if (isYamlMapping(value)) {
    for (const [child, childValue] of Object.entries(value)) children[child] = flowValue(childValue);
  }
  Object.assign(children, writes);
  return [`${key}:`, ...Object.entries(children).map(([k, v]) => `  ${childKey(k)}: ${v}`)];
}

/** Any value written from what it parses to: a mapping or list as an indented block, anything else on its key line. */
function valueLines(key: string, value: unknown): string[] {
  if (isYamlMapping(value) && Object.keys(value).length > 0) {
    return [`${key}:`, ...Object.entries(value).map(([k, v]) => `  ${childKey(k)}: ${flowValue(v)}`)];
  }
  if (Array.isArray(value) && value.length > 0) return [`${key}:`, ...value.map((item) => `  - ${flowValue(item)}`)];
  return [`${key}: ${flowValue(value)}`];
}

/**
 * A site entry's lines from its key line on, written from its value, or null
 * to copy the entry verbatim: a managed block its writer cannot edit, and an
 * entry read from the whole document, are written from their values.
 */
function linesFromValue(site: ReadEntry, written: Record<string, Record<string, string>>): string[] | null {
  const { entry, value } = site;
  if (isBlockKey(entry.key) && (site.resolved || blockUnwritable(entry))) {
    return blockLines(entry.key, value, written[entry.key] ?? {});
  }
  return site.resolved ? valueLines(entry.key, value) : null;
}

/**
 * Whether `line` may hold a comment, whole or trailing: a `#` at its start or
 * after whitespace, wherever it falls. Quotes are not read, so a `#` inside a
 * quoted value counts too: an apostrophe in plain text would otherwise pair
 * with one in the comment and hide it, and over-reporting is the safe error.
 */
function holdsComment(line: string): boolean {
  return /(^|[ \t])#/.test(line);
}

/**
 * A site entry as the rebuilt file carries it, and whether an entry written
 * from its value dropped a comment of its own, whole-line or trailing. A
 * managed field the Site settings write is written as the writer writes it,
 * so the writer never has to find where the file's value ends; its trailing
 * comment goes as it does on every publish. Every other entry is verbatim.
 */
function writableEntry(
  site: ReadEntry,
  fields: Record<string, string>,
  written: Record<string, Record<string, string>>,
): { lines: string[]; commentDropped: boolean; ambiguous?: boolean } {
  const { entry } = site;
  const keyLine = entry.lines.findIndex((line) => PLAIN_KEY.test(line));
  const leading = entry.lines.slice(0, keyLine);
  if (Object.hasOwn(fields, entry.key)) {
    return { lines: [...leading, `${entry.key}: ${fields[entry.key]}`], commentDropped: false };
  }
  const fromValue = linesFromValue(site, written);
  if (fromValue === null) return { lines: entry.lines, commentDropped: false };
  return {
    lines: [...leading, ...fromValue],
    commentDropped: entry.lines.slice(keyLine).some(holdsComment),
    ambiguous: holdsUnfaithfulValue(valueWithoutWrites(site.value, written[entry.key])),
  };
}

/** The plain scalars YAML 1.1 reads as booleans. */
const YAML11_BOOLEAN = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;

/** The plain scalars YAML 1.1 reads as numbers where YAML 1.2 reads strings: base 60, a leading-zero octal, `0b` binary, digits with underscores. */
const YAML11_NUMBER = [
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/,
  /^[-+]?0[0-7_]+$/,
  /^[-+]?0b[01_]+$/,
  /^[-+]?(?=[0-9._]*_)[0-9_]*\.?[0-9_]+$/,
];

/** Whether YAML 1.1 reads `text`, written plain, as something other than a string. */
function yaml11ReadsAsOther(text: string): boolean {
  return YAML11_BOOLEAN.test(text) || YAML11_NUMBER.some((form) => form.test(text));
}

/** Whether a key, written plain, reads as a number under the core schema or as another type under YAML 1.1. */
function keyReadsAsOther(key: string): boolean {
  return yaml11ReadsAsOther(key) || typeof writtenScalarValue(key) === "number";
}

/**
 * Whether a parsed value cannot be written back to read the same under
 * Jekyll's Psych (YAML 1.1) as under the core schema it was read with. Only
 * strings, booleans and nulls are written back faithfully: a number may have
 * been an octal or base-60 form Psych reads differently (`04000`), and a
 * string may be one YAML 1.1 reads as a boolean or a number. Keys as well as
 * values.
 */
function holdsUnfaithfulValue(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (typeof value === "string") return yaml11ReadsAsOther(value);
  if (Array.isArray(value)) return value.some(holdsUnfaithfulValue);
  if (!isYamlMapping(value)) return false;
  return Object.entries(value).some(([key, child]) => keyReadsAsOther(key) || holdsUnfaithfulValue(child));
}

/** A regenerated value without the managed children the Site settings write over it. */
function valueWithoutWrites(value: unknown, writes: Record<string, string> | undefined): unknown {
  if (!writes || !isYamlMapping(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(writes, key)));
}

/** The site entries in the order the rebuilt file carries them, each after the template entry it replaces. */
function placedEntries(template: SplitConfig, read: Map<string, ReadEntry>): Array<ReadEntry | Entry> {
  const placed = new Set<string>();
  const order: Array<ReadEntry | Entry> = [];
  for (const entry of template.entries) {
    if (placed.has(entry.key)) continue;
    placed.add(entry.key);
    order.push(read.get(entry.key) ?? entry);
  }
  const rest = [...read.values()].filter((site) => !placed.has(site.entry.key));
  rest.sort((a, b) => a.entry.at - b.entry.at);
  return [...order, ...rest];
}

/**
 * The template and site entries put together, before the Site settings are
 * written; whether a site entry written from its value dropped a comment; and
 * whether one holds a value Psych may read otherwise (`holdsUnfaithfulValue`).
 */
function assemble(
  template: SplitConfig,
  read: Map<string, ReadEntry>,
  config: ConfigRow,
): { text: string; commentDropped: boolean; ambiguous: boolean } {
  const fields = buildConfigManagedFields(config);
  const written = buildConfigManagedBlocks(config);
  const out = [...template.header];
  let commentDropped = false;
  let ambiguous = false;
  for (const placed of placedEntries(template, read)) {
    const site = "entry" in placed ? writableEntry(placed, fields, written) : { lines: placed.lines, commentDropped: false };
    out.push(...site.lines);
    commentDropped ||= site.commentDropped;
    ambiguous ||= site.ambiguous === true;
  }
  return { text: `${out.join("\n")}\n`, commentDropped, ambiguous };
}

/** The value one written scalar reads as. */
function writtenScalarValue(scalar: string): unknown {
  return yamlMappingWithoutMerges(`v: ${scalar}`)?.v;
}

/** `value` with `telar.version`'s leading `v` removed, as the writer heals it. */
function healedTelar(value: unknown): unknown {
  if (!isYamlMapping(value) || typeof value.version !== "string") return value;
  return { ...value, version: value.version.replace(/^v/, "") };
}

/** A glossary value without its `kinds`, an absent glossary reading as an empty one. */
function glossaryRest(value: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (!isYamlMapping(value)) return value;
  const { kinds: _kinds, ...rest } = value;
  return rest;
}

/** What the rewrite must give `key`, read from the site as `value`, once the Site settings are written. */
function expectedValue(key: string, value: unknown, config: ConfigRow): unknown {
  const fields = buildConfigManagedFields(config);
  if (Object.hasOwn(fields, key)) return writtenScalarValue(fields[key]);
  if (key === "telar") return healedTelar(value);
  const blocks = buildConfigManagedBlocks(config);
  if (!Object.hasOwn(blocks, key)) return value;
  const base = isYamlMapping(value) ? value : {};
  const children = Object.fromEntries(Object.entries(blocks[key]).map(([k, v]) => [k, writtenScalarValue(v)]));
  return { ...base, ...children };
}

/**
 * The value of each key read from the site: the one the site's first document
 * gives read whole, where it parses, so an entry the split cut in the wrong
 * place shows as a value the result does not hold; otherwise the entry's own.
 */
function siteValues(split: SplitConfig, read: Map<string, ReadEntry>): Map<string, unknown> {
  const whole = yamlMappingWithoutMerges(split.document.join("\n"));
  const values = new Map<string, unknown>();
  for (const [key, entry] of read) {
    values.set(key, whole !== null && Object.hasOwn(whole, key) ? whole[key] : entry.value);
  }
  return values;
}

/**
 * Every value the self-check holds the result to: each top-level key of the
 * site's first document read whole, where it parses, whether or not the split
 * found an entry for it, so a key the split lost is a key the result lacks;
 * otherwise each key the entries read.
 */
function checkedSiteValues(split: SplitConfig): Array<[string, unknown]> {
  const whole = yamlMappingWithoutMerges(split.document.join("\n"));
  return whole !== null ? Object.entries(whole) : [...siteValues(split, readConfig(split).read)];
}

/** Whether `result` holds `value`, read from the site under `key`, as the rewrite must. */
function holdsSiteValue(key: string, value: unknown, result: YamlMapping, config: ConfigRow, kinds: string | null): boolean {
  if (key === "glossary" && kinds !== null) return sameYamlValue(glossaryRest(value), glossaryRest(result.glossary));
  return Object.hasOwn(result, key) && sameYamlValue(expectedValue(key, value, config), result[key]);
}

/** Whether `result` holds every top-level value the Site settings write. */
function holdsWrittenFields(result: YamlMapping, config: ConfigRow): boolean {
  return Object.entries(buildConfigManagedFields(config)).every(([key, scalar]) =>
    sameYamlValue(writtenScalarValue(scalar), result[key]),
  );
}

/** Whether `result` holds every managed block child the Site settings write. */
function holdsWrittenBlocks(result: YamlMapping, config: ConfigRow): boolean {
  return Object.entries(buildConfigManagedBlocks(config)).every(([block, children]) => {
    const written = result[block];
    return (
      isYamlMapping(written) &&
      Object.entries(children).every(([child, scalar]) => sameYamlValue(writtenScalarValue(scalar), written[child]))
    );
  });
}

/** `text` read as the framework's Jekyll reads it, merges resolved; null when it does not parse to a mapping. */
function mergedReading(text: string): YamlMapping | null {
  try {
    const doc = parseYaml(text);
    return doc === null || doc === undefined ? {} : isYamlMapping(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** The top-level keys whose value the Site settings write or the writer heals, which the merged comparison leaves to the core one. */
function writtenKeys(config: ConfigRow, kinds: string | null): Set<string> {
  const keys = [...Object.keys(buildConfigManagedFields(config)), ...Object.keys(buildConfigManagedBlocks(config)), "telar"];
  if (kinds !== null) keys.push("glossary");
  return new Set(keys);
}

/**
 * Whether `text` gives every other top-level key of the site's first document
 * the value it has with merges resolved, as Jekyll reads the file. The core
 * reading takes `<<` for an ordinary key, so a merge written back as a quoted
 * key reads the same there and differs only here. A site document that does
 * not parse this way has nothing to compare.
 */
function holdsMergedValues(split: SplitConfig, text: string, config: ConfigRow, kinds: string | null): boolean {
  const site = mergedReading(split.document.join("\n"));
  if (site === null) return true;
  const result = mergedReading(text);
  if (result === null) return false;
  const written = writtenKeys(config, kinds);
  return Object.entries(site).every(([key, value]) => written.has(key) || (Object.hasOwn(result, key) && sameYamlValue(value, result[key])));
}

/**
 * Whether `text`, rebuilt from `site`, holds every value read from the site's
 * file and every value the Site settings write, compared as YAML under the
 * core schema, over every key `checkedSiteValues` gives, and with merges
 * resolved (`holdsMergedValues`). The glossary kinds are compared as the
 * framework reads them.
 */
export function rewriteKeepsSite(site: string, text: string, config: ConfigRow): boolean {
  const result = yamlMappingWithoutMerges(text);
  if (result === null) return false;
  const kinds = canonicalKindsJson(config.glossary_kinds_json);
  if (kinds !== null && repoGlossaryKindsJson(text) !== kinds) return false;
  const split = splitConfig(site);
  const values = checkedSiteValues(split);
  return (
    values.every(([key, value]) => holdsSiteValue(key, value, result, config, kinds)) &&
    holdsMergedValues(split, text, config, kinds) &&
    holdsWrittenFields(result, config) &&
    holdsWrittenBlocks(result, config)
  );
}

/**
 * The names a changed setting is listed under: its children that changed, for
 * a block, a block the rewrite removes reading as one with no children; else
 * itself.
 */
function changedNames(key: string, before: unknown, after: unknown): string[] {
  if (!isBlockKey(key) || !(isYamlMapping(before) || isYamlMapping(after))) return [key];
  const was: YamlMapping = isYamlMapping(before) ? before : {};
  const now: YamlMapping = isYamlMapping(after) ? after : {};
  const children = new Set([...Object.keys(was), ...Object.keys(now)]);
  const changed = [...children].filter((child) => !sameYamlValue(was[child], now[child]));
  return changed.length > 0 ? changed.map((child) => `${key}.${child}`) : [key];
}

/** Every full comment line in `lines`, trimmed, with how many times it occurs. */
function commentCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return counts;
}

/** What the rewrite keeps, replaces and takes from the template, read from the final text. */
function reportOf(
  text: string,
  read: Map<string, unknown>,
  templateRead: Map<string, ReadEntry>,
  site: string,
): Omit<ConfigRewriteReport, "templateTag" | "removed"> {
  const result = yamlMappingWithoutMerges(text) ?? {};
  const kept: string[] = [];
  const fromSettings: string[] = [];
  const templateValues: string[] = [];
  // The site's keys too: one the Site settings clear is absent from the result.
  for (const key of new Set([...Object.keys(result), ...read.keys()])) {
    const value = Object.hasOwn(result, key) ? result[key] : undefined;
    if (read.has(key)) {
      const before = key === "telar" ? healedTelar(read.get(key)) : read.get(key);
      if (sameYamlValue(before, value)) kept.push(key);
      else fromSettings.push(...changedNames(key, before, value));
      continue;
    }
    const fromTemplate = templateRead.get(key);
    if (fromTemplate && sameYamlValue(fromTemplate.value, value)) templateValues.push(key);
    else fromSettings.push(...changedNames(key, fromTemplate?.value, value));
  }
  const remaining = commentCounts(text.split("\n"));
  const commentsDropped = [...commentCounts(site.split(/\r?\n/))].some(
    ([comment, count]) => (remaining.get(comment) ?? 0) < count,
  );
  return { kept, fromSettings, templateValues, commentsDropped };
}

/**
 * `site` rebuilt from `template` with the Site settings in `config` written
 * in, and the report of what the rewrite does; null when the Site settings
 * cannot be written into the rebuilt file, a value written from its parsed
 * form holds a value Psych may read otherwise (`holdsUnfaithfulValue`), or
 * the result loses a value the site's file held (`rewriteKeepsSite`), each of
 * which is logged.
 */
export function rebuildConfigYaml(site: string, template: ConfigTemplate, config: ConfigRow): RebuiltConfig | null {
  const siteSplit = splitConfig(site);
  const { read, removed } = readConfig(siteSplit);
  const templateSplit = splitConfig(template.text);
  const assembled = assemble(templateSplit, read, config);
  if (assembled.ambiguous) {
    console.error("[config-rewrite] a value written from its parsed form may read differently under Jekyll's YAML");
    return null;
  }
  let text: string | null;
  try {
    const written = publishableConfigYaml(assembled.text, config);
    text = written === null ? null : cleanCommitContent("_config.yml", written);
  } catch (err) {
    console.error("[config-rewrite] the Site settings could not be written into the rebuilt file", err);
    return null;
  }
  if (text === null || !rewriteKeepsSite(site, text, config)) {
    console.error("[config-rewrite] the rebuilt file does not keep the site's settings", { template: template.tag });
    return null;
  }
  const report = reportOf(text, siteValues(siteSplit, read), readConfig(templateSplit).read, site);
  const commentsDropped = report.commentsDropped || assembled.commentDropped;
  return { text, report: { templateTag: template.tag, removed, ...report, commentsDropped } };
}

/**
 * The template's `_config.yml`: the one at the site's own release, or at the
 * latest release (`pinnedTag`, the deployment's pin, when set) when the site
 * has no stored version or its tag has no such file. Null when neither can be
 * read.
 */
export async function fetchConfigTemplate(
  token: string,
  telarVersion: string | null | undefined,
  pinnedTag?: string,
): Promise<ConfigTemplate | null> {
  try {
    if (telarVersion && telarVersion.trim() !== "") {
      const tag = normalizeVersionTag(telarVersion.trim());
      const read = await fetchFrameworkFile(token, "_config.yml", tag);
      if (read.kind === "found") return { tag, text: read.content };
      if (read.kind === "failed") return null;
    }
    const latest = await fetchLatestRelease(token, pinnedTag);
    const read = await fetchFrameworkFile(token, "_config.yml", latest.tagName);
    return read.kind === "found" ? { tag: latest.tagName, text: read.content } : null;
  } catch (err) {
    console.warn("[config-rewrite] the template could not be read", err);
    return null;
  }
}

/** The fingerprint of a rebuilt file: a SHA-256 of its text. */
export async function configRewriteFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The rewrite of `site` for `config`, with its fingerprint, as the preview
 * shows it and the publish checks it. `frameworkToken` reads the public
 * framework repository.
 */
export async function prepareConfigRewrite(input: {
  frameworkToken: string;
  pinnedTag?: string;
  site: string;
  config: ConfigRow;
}): Promise<ConfigRewritePreparation> {
  const template = await fetchConfigTemplate(input.frameworkToken, input.config.telar_version, input.pinnedTag);
  if (template === null) return { kind: "template_unavailable" };
  const rebuilt = rebuildConfigYaml(input.site, template, input.config);
  if (rebuilt === null) return { kind: "failed" };
  return { kind: "ready", ...rebuilt, fingerprint: await configRewriteFingerprint(rebuilt.text) };
}

/**
 * The rewrite a publish would make now, for the review: the file read at the
 * head of `main` on `projectToken`, as the publish reads it, and the project's
 * settings row. `config_unreadable` when either could not be read.
 */
export async function previewConfigRewrite(input: {
  db: ReturnType<typeof getDb>;
  projectId: number;
  projectToken: string;
  frameworkToken: string;
  owner: string;
  repo: string;
  pinnedTag?: string;
}): Promise<ConfigRewritePreparation | { kind: "config_unreadable" }> {
  const { db, projectToken, owner, repo } = input;
  const head = await getRepoHead(projectToken, owner, repo, "main");
  const [file, rows] = await Promise.all([
    getFileAtRef(projectToken, owner, repo, "_config.yml", head, { strict: true }),
    db.select().from(project_config).where(eq(project_config.project_id, input.projectId)).limit(1),
  ]);
  if (file.status !== "ok" || !rows[0]) return { kind: "config_unreadable" };
  return prepareConfigRewrite({
    frameworkToken: input.frameworkToken,
    pinnedTag: input.pinnedTag,
    site: file.content.replace(/^\uFEFF/, ""),
    config: rows[0],
  });
}

/** What a publish carries of the rewrite the author accepted. */
export interface PublishConfigRewrite {
  /** For the publish check (`runPrePublishValidation`); undefined when the request accepted none. */
  check: AcknowledgedConfigRewrite | undefined;
  /** The text the file set writes, only when it is the accepted rewrite of a file that needs one. */
  text: string | undefined;
}

const NO_REWRITE: PublishConfigRewrite = { check: undefined, text: undefined };

/**
 * The rewrite a publish request accepted, rebuilt once from the file and the
 * row the publish judged. Its fingerprint decides whether it answers
 * `config_needs_rewrite`, and its text is the one the file set writes.
 */
export async function configRewriteForPublish(input: {
  acknowledged: string | null;
  site: string | null;
  config: ConfigRow | null | undefined;
  frameworkToken: string;
  pinnedTag?: string;
}): Promise<PublishConfigRewrite> {
  const { acknowledged, site, config } = input;
  if (acknowledged === null) return NO_REWRITE;
  const rebuilt = site !== null && config
    ? await prepareConfigRewrite({ frameworkToken: input.frameworkToken, pinnedTag: input.pinnedTag, site, config })
    : null;
  const ready = rebuilt?.kind === "ready" ? rebuilt : null;
  const matches = ready !== null && ready.fingerprint === acknowledged && configNeedsRewrite(site, config);
  return {
    check: { acknowledged, fingerprint: ready?.fingerprint ?? null },
    text: matches ? ready.text : undefined,
  };
}

/**
 * The refusal of a publish its check blocked: `config_rewrite_stale` when the
 * request accepted a rewrite and `config_needs_rewrite` still stands, so the
 * page can ask for a new review; otherwise `validation_blocked`.
 */
export function blockedPublishError(
  blockers: readonly ValidationItem[],
  rewrite: PublishConfigRewrite,
): "config_rewrite_stale" | "validation_blocked" {
  const stale = rewrite.check !== undefined && blockers.some((b) => b.code === "config_needs_rewrite");
  return stale ? "config_rewrite_stale" : "validation_blocked";
}

/** The publish route's answer to `preview-config-rewrite`. */
export type ConfigRewritePreviewAnswer =
  | { ok: true; intent: "preview-config-rewrite"; report: ConfigRewriteReport; fingerprint: string }
  | { ok: false; intent: "preview-config-rewrite"; error: string };

/**
 * The publish route's `preview-config-rewrite`, for anyone who can save Site
 * settings (`title` is a field every such role writes). `snapshot` writes the
 * document's settings to D1 first, as the publish does before it reads them.
 */
export async function configRewritePreviewAnswer(input: {
  role: string;
  snapshot: () => Promise<unknown>;
  projectToken: () => Promise<string>;
  db: ReturnType<typeof getDb>;
  projectId: number;
  frameworkToken: string;
  owner: string;
  repo: string;
  pinnedTag?: string;
}): Promise<ConfigRewritePreviewAnswer> {
  const intent = "preview-config-rewrite" as const;
  if (!canWriteConfigField("title", input.role)) return { ok: false, intent, error: "forbidden" };
  try {
    await input.snapshot();
    const preview = await previewConfigRewrite({ ...input, projectToken: await input.projectToken() });
    return preview.kind === "ready"
      ? { ok: true, intent, report: preview.report, fingerprint: preview.fingerprint }
      : { ok: false, intent, error: preview.kind };
  } catch (err) {
    console.error("[publish] preview-config-rewrite failed", err);
    return { ok: false, intent, error: "preview_failed" };
  }
}
