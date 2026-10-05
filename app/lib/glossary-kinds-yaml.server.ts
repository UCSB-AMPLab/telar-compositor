/**
 * The site's own glossary kinds, written into `_config.yml` text where the
 * framework reads them: the `kinds:` list under the top-level `glossary:` key
 * (`scripts/telar/glossary_kinds.py`). That key is not `collections:` ->
 * `glossary:`, which is indented and never matched here.
 *
 * The edit is line-based, like every other `_config.yml` write: only the
 * `kinds:` child of `glossary:` is replaced, and every other child, comment
 * and blank line comes through as it was found. A `glossary:` whose header
 * carries anything but a comment (a flow mapping, a scalar, an anchor, an
 * alias, a tag) or that takes keys through a `<<` merge holds its mapping
 * where these lines are not, so the writer refuses it rather than guess.
 *
 * @version v1.5.0-beta
 */

import { load as loadYaml } from "js-yaml";
import { findYamlBlockRegions, isBlankOrComment, type YamlBlockRegion } from "~/lib/config-yaml-block.server";
import { escapeYamlString } from "~/lib/knap-filters.server";
import { composePyYaml } from "~/lib/pyyaml";
import { isYamlMapping, sameYamlValue, yamlMappingOf } from "~/lib/yaml.server";
import { serializeSiteKinds, storedSiteKinds, toSiteKind, type SiteKind } from "~/lib/glossary-kinds";

/** One child entry of the block: indentation, key, and what follows the colon. */
const CHILD_ENTRY = /^([ \t]*)([A-Za-z0-9_-]+|<<)[ \t]*:([ \t].*|)$/;

/**
 * The stored kinds in their canonical shape (`toSiteKind`), or null when the
 * column holds no list. Null is a project that follows the repository's
 * `_config.yml`, and a publish leaves that file's kinds exactly as it found
 * them.
 */
export function parseStoredGlossaryKinds(json: string | null | undefined): SiteKind[] | null {
  return storedSiteKinds(json)?.map(toSiteKind) ?? null;
}

/**
 * The canonical JSON of the kinds a parsed top-level `glossary:` value lists,
 * or null when it holds no list. Entries the framework would reject are kept:
 * the author fixes them in the Compositor.
 */
export function glossaryKindsJsonOf(glossary: unknown): string | null {
  const kinds = isYamlMapping(glossary) ? glossary.kinds : undefined;
  return Array.isArray(kinds) ? serializeSiteKinds(kinds) : null;
}

/**
 * The canonical JSON of the site kinds `_config.yml` text gives the
 * framework, or null when the text does not parse. A config without a
 * `glossary.kinds` list gives none, which is `[]`: removing the list on
 * GitHub is a change to a stored one.
 */
export function repoGlossaryKindsJson(configYml: string): string | null {
  try {
    const config: unknown = loadYaml(configYml);
    return glossaryKindsJsonOf(isYamlMapping(config) ? config.glossary : undefined) ?? "[]";
  } catch {
    return null;
  }
}

/** The column's list in canonical JSON, or null when the column holds none. */
export function canonicalKindsJson(json: string | null | undefined): string | null {
  const kinds = storedSiteKinds(json);
  return kinds === null ? null : serializeSiteKinds(kinds);
}

/** The `kinds:` child as the framework reads it, at the block's child indentation. */
function kindsLines(indent: string, kinds: SiteKind[]): string[] {
  const q = escapeYamlString;
  const item = (k: SiteKind) => [
    `${indent}  - id: ${q(k.id)}`,
    `${indent}    label: ${q(k.label)}`,
    `${indent}    heading: ${q(k.heading)}`,
    ...(k.values.length > 0 ? [`${indent}    values: [${k.values.map(q).join(", ")}]`] : []),
  ];
  return [`${indent}kinds:`, ...kinds.flatMap(item)];
}

/**
 * Whether `line` ends the lines of a child at `indent`: a shallower line, or
 * a sibling entry at the same indentation. A same-indented line that is not
 * an entry (`- item`, the `]` closing a flow list) still belongs to the child.
 */
function endsChild(line: string, indent: number): boolean {
  if (isBlankOrComment(line)) return false;
  const own = line.match(/^[ \t]*/)![0].length;
  return own < indent || (own === indent && CHILD_ENTRY.test(line));
}

/** Where one `kinds:` child's lines end, trailing comments and blanks left outside it. */
function kindsSpanEnd(lines: string[], start: number, region: YamlBlockRegion): number {
  let end = start + 1;
  while (end < region.regionEnd && !endsChild(lines[end], region.childIndent.length)) end++;
  while (end > start + 1 && isBlankOrComment(lines[end - 1])) end--;
  return end;
}

/**
 * The line indexes of every `kinds:` child of the block, or null when the
 * block is not one these lines can edit: a `<<` merge may bring kinds in from
 * elsewhere, and an anchored, aliased or tagged `kinds:` is a node other lines
 * may point at.
 */
function kindsLineIndexes(lines: string[], region: YamlBlockRegion): Set<number> | null {
  const indexes = new Set<number>();
  for (let i = region.headerIdx + 1; i < region.regionEnd; i++) {
    const entry = lines[i].match(CHILD_ENTRY);
    if (!entry || entry[1] !== region.childIndent) continue;
    if (entry[2] === "<<" || (entry[2] === "kinds" && /^\s*[&*!]/.test(entry[3]))) return null;
    if (entry[2] !== "kinds") continue;
    const end = kindsSpanEnd(lines, i, region);
    for (let j = i; j < end; j++) indexes.add(j);
  }
  return indexes;
}

/** The block's lines without `old`, with `written` at the first of them, or first of all. */
function bodyWith(lines: string[], region: YamlBlockRegion, old: Set<number>, written: string[]): string[] {
  const at = old.size > 0 ? Math.min(...old) : region.headerIdx + 1;
  const body: string[] = [];
  for (let i = region.headerIdx + 1; i <= region.regionEnd; i++) {
    if (i === at) body.push(...written);
    if (i < region.regionEnd && !old.has(i)) body.push(lines[i]);
  }
  return body;
}

/** `lines` with the block's `kinds:` children replaced by `written`. */
function replaceKinds(lines: string[], region: YamlBlockRegion, written: string[]): string[] | null {
  const header = lines[region.headerIdx].slice("glossary:".length).trim();
  if (header !== "" && !header.startsWith("#")) return null;
  const old = kindsLineIndexes(lines, region);
  if (old === null) return null;
  const body = bodyWith(lines, region, old, written);
  // Only a `glossary:` this edit emptied goes: one already empty is the
  // author's, and leaving it costs nothing.
  const emptied = old.size > 0 && body.every(isBlankOrComment);
  const head = emptied ? [] : [lines[region.headerIdx]];
  return [...lines.slice(0, region.headerIdx), ...head, ...body, ...lines.slice(region.regionEnd)];
}

/** `lines` with a new `glossary:` block after the last content line. */
function appendGlossary(lines: string[], kinds: SiteKind[]): string[] {
  if (kinds.length === 0) return lines;
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return [...lines.slice(0, end), "glossary:", ...kindsLines("  ", kinds), ...lines.slice(end)];
}

/**
 * `yaml` with `kinds` as its glossary kinds, or null when its `glossary:` is
 * written in a shape this writer cannot edit.
 *
 * With no `glossary:` the block is appended; without a `kinds:` child, one is
 * inserted as its first child; an existing `kinds:`, block or flow, is
 * replaced where it stands. An empty list removes `kinds:`, and `glossary:`
 * too when nothing else is left under it. The LAST `glossary:` is the one
 * edited, since it is the one every reader of the file takes.
 */
export function writeGlossaryKinds(yaml: string, kinds: SiteKind[]): string | null {
  const eol = yaml.includes("\r\n") ? "\r\n" : "\n";
  const lines = yaml.split(/\r?\n/);
  const region = findYamlBlockRegions(lines, "glossary").at(-1);
  const written = region === undefined
    ? appendGlossary(lines, kinds)
    : replaceKinds(lines, region, kinds.length > 0 ? kindsLines(region.childIndent, kinds) : []);
  const text = written?.join(eol) ?? null;
  return text !== null && changedOnlyKinds(yaml, text, kinds) ? text : null;
}

/** How many top-level keys of `yaml` read as `glossary`, however each is spelled. */
function glossaryKeyCount(yaml: string): number {
  const root = composePyYaml(yaml);
  if (root?.kind !== "mapping") return 0;
  return root.children.filter((node, i) => i % 2 === 0 && node.text === "glossary").length;
}

/** A kind as its written lines read back: `values` only when it has some. */
const asWrittenKind = ({ values, ...kind }: SiteKind) => (values.length > 0 ? { ...kind, values } : kind);

/** The `glossary` value a file should read as once `kinds` is written into `original`. */
function expectedGlossary(original: unknown, kinds: SiteKind[]): unknown {
  if (kinds.length === 0 && !(isYamlMapping(original) && Object.hasOwn(original, "kinds"))) return original;
  const { kinds: _old, ...rest } = isYamlMapping(original) ? original : {};
  if (kinds.length > 0) return { ...rest, kinds: kinds.map(asWrittenKind) };
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Whether `after` reads as `before` with only `glossary.kinds` changed, to
 * `kinds` (absent when empty). The line edit cannot see every spelling YAML
 * allows (a quoted key, a spaced or quoted header, a second `glossary:`), so
 * the parsed result is the judge: anything else moved, or a file with two
 * `glossary` keys, where an edit to one leaves the other to be read, is
 * refused rather than published.
 */
function changedOnlyKinds(before: string, after: string, kinds: SiteKind[]): boolean {
  const [was, now] = [yamlMappingOf(before), yamlMappingOf(after)];
  if (was === null || now === null || glossaryKeyCount(before) > 1) return false;
  const { glossary: original, ...others } = was;
  const glossary = expectedGlossary(original, kinds);
  return sameYamlValue(glossary === undefined ? others : { ...others, glossary }, now);
}
