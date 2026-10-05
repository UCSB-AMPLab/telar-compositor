/**
 * One file per page. A Telar site is in one language, and the template ships
 * some pages twice so that it works in either: `about.md`, and `acerca.md`
 * with `localized_for: about.md` and `language: es`. The framework's
 * `generate_pages` (the framework's scripts/telar/pages.py) writes the file
 * whose `language` is the site's `telar_language` at the named page's address,
 * and never shows the other. The Compositor reduces such a page to the one
 * file the build serves when a site comes into it, and from then on reads
 * every file as a page of its own.
 *
 * The framework reads the front matter with PyYAML and tests `localized_for`
 * and `language` with Python's rules, so the values are typed here by the
 * PyYAML port in `pyyaml.ts`:
 *
 * - `localized_for` false in Python makes a page of its own;
 * - otherwise a `language` false in Python makes a file the build skips;
 * - otherwise a list or mapping in either is a dictionary key the build
 *   raises on, which stops the whole site building;
 * - otherwise the file is shown at the address of the page whose file name
 *   equals `localized_for` exactly, when its `language` is the site's, and
 *   nowhere when there is no such page.
 *
 * Not modelled, being inputs no author writes: two files for one page in the
 * site's language, where the framework takes whichever its directory listing
 * yields last and the reduction takes the last in name order; a served file
 * whose `localized_for` or `language` is written inline (a flow mapping, a
 * merge), whose pair is left as it is; values that stop the build, which
 * are left as they are; and a pages folder holding only files that name a
 * missing page, which the Pages screen's import finds nothing to import from
 * and so records nothing for.
 *
 * Pure: no document, no React, no network.
 *
 * @version v1.5.0-beta
 */

import { composePyYaml, constructionFails, mappingValue, STR_TAG, YAML_TAG, type PyYamlNode } from "~/lib/pyyaml";

export interface PyValue {
  truthy: boolean;
  hashable: boolean;
  /** The Python string, when the value is one. */
  string: string | null;
  /** Python's equality class for the value as a dictionary key. */
  key: string;
  /** The value as the author wrote it, for naming it back. */
  text: string;
}

/** One page's reading of its block. */
export type BlockReading =
  | { kind: "not-built" | "breaks-build" | "canonical" }
  | { kind: "localized"; localizedFor: PyValue; language: PyValue };


/** The site's `telar_language` as the build reads it: an empty setting is `en`. */
export function telarLanguageOf(lang: unknown): string {
  return typeof lang === "string" && lang !== "" ? lang : "en";
}

const NULL_VALUE: PyValue = { truthy: false, hashable: true, string: null, key: "none", text: "" };

const TRUE_WORDS = new Set(["yes", "true", "on"]);

/** Every digit of a YAML 1.1 integer is zero: sign, radix prefix, underscores and sexagesimal colons aside. */
function isZeroInt(text: string): boolean {
  return /^0*$/.test(text.replace(/_/g, "").replace(/^[-+]/, "").replace(/^0[bx]/, "").replace(/:/g, ""));
}

/** A YAML 1.1 float that is zero. NaN and the infinities are not. */
function isZeroFloat(text: string): boolean {
  if (/(inf|nan)/i.test(text)) return false;
  return /^0*$/.test(text.replace(/_/g, "").replace(/^[-+]/, "").replace(/[eE].*$/, "").replace(/[.:]/g, ""));
}

/** A YAML 1.1 integer's value (radix prefixes, octal, sexagesimal), for key equality. */
function intValue(text: string): number {
  const clean = text.replace(/_/g, "");
  const sign = clean.startsWith("-") ? -1 : 1;
  const digits = clean.replace(/^[-+]/, "");
  if (digits.startsWith("0b")) return sign * parseInt(digits.slice(2), 2);
  if (digits.startsWith("0x")) return sign * parseInt(digits.slice(2), 16);
  if (digits.includes(":")) return sign * digits.split(":").reduce((n, part) => n * 60 + Number(part), 0);
  if (digits.length > 1 && digits.startsWith("0")) return sign * parseInt(digits, 8);
  return sign * Number(digits);
}

/**
 * How a node reads back, for naming a value the author wrote. A collection
 * inside itself reads as Python's `repr` writes it, `[...]` or `{...}`.
 */
function writtenText(node: PyYamlNode, open = new Set<PyYamlNode>()): string {
  if (node.kind === "scalar") return node.text;
  if (open.has(node)) return node.kind === "sequence" ? "[...]" : "{...}";
  open.add(node);
  const text = node.kind === "sequence" ? `[${node.children.map((c) => writtenText(c, open)).join(", ")}]` : writtenPairs(node, open);
  open.delete(node);
  return text;
}

function writtenPairs(node: PyYamlNode, open: Set<PyYamlNode>): string {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < node.children.length; i += 2) {
    pairs.push(`${writtenText(node.children[i], open)}: ${writtenText(node.children[i + 1], open)}`);
  }
  return `{${pairs.join(", ")}}`;
}

/** A scalar's Python truthiness and dictionary key, by its PyYAML tag. */
function scalarValue(node: PyYamlNode): PyValue {
  const text = node.text;
  const base = { hashable: true, string: null, text };
  switch (node.tag) {
    case STR_TAG:
      return { ...base, truthy: text !== "", string: text, key: `s:${text}` };
    case `${YAML_TAG}null`:
      return { ...NULL_VALUE, text };
    case `${YAML_TAG}bool`: {
      const value = TRUE_WORDS.has(text.toLowerCase());
      return { ...base, truthy: value, key: `n:${value ? 1 : 0}` };
    }
    case `${YAML_TAG}int`:
      return { ...base, truthy: !isZeroInt(text), key: `n:${intValue(text)}` };
    case `${YAML_TAG}float`:
      return { ...base, truthy: !isZeroFloat(text), key: `n:${Number(text.replace(/_/g, ""))}` };
    case `${YAML_TAG}binary`:
      return { ...base, truthy: text.replace(/\s/g, "") !== "", key: `b:${text}` };
    default:
      return { ...base, truthy: true, key: `${node.tag}:${text}` };
  }
}

/**
 * Whether a mapping holds anything once PyYAML's `flatten_mapping` has run: a
 * direct pair other than a merge key, or a merged mapping that does. A mapping
 * already looked at adds nothing, so one merging only itself is `{}`.
 */
function mappingHoldsPairs(mapping: PyYamlNode, seen = new Set<PyYamlNode>()): boolean {
  if (mapping.kind !== "mapping" || seen.has(mapping)) return false;
  seen.add(mapping);
  for (let i = 0; i + 1 < mapping.children.length; i += 2) {
    const [key, value] = [mapping.children[i], mapping.children[i + 1]];
    if (key.tag !== `${YAML_TAG}merge`) return true;
    const merged = value.kind === "sequence" ? value.children : [value];
    if (merged.some((m) => mappingHoldsPairs(m, seen))) return true;
  }
  return false;
}

/** A node as Python holds it: a list, set or dict is unhashable, and false when empty. */
function pyValue(node: PyYamlNode | undefined): PyValue {
  if (node === undefined) return NULL_VALUE;
  if (node.kind === "scalar") return scalarValue(node);
  const truthy = node.kind === "sequence" ? node.children.length > 0 : mappingHoldsPairs(node);
  return { truthy, hashable: false, string: null, key: "", text: writtenText(node) };
}

/** A block holding nothing but blank lines and comments, which loads as None. */
function isEmptyDocument(block: string): boolean {
  return block.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line));
}

/**
 * What a root that does not load as a dict is to the build, or null for a
 * dict. A list, a scalar, or a mapping tagged `!!set` (which PyYAML builds as
 * a set) fails `fm.get` when Python reads it as true, and is `{}` otherwise.
 * Any other tag on a mapping is one SafeConstructor refuses for that node
 * kind, a YAML error the build skips the file over.
 */
function readNonDictRoot(root: PyYamlNode): BlockReading | null {
  const setRoot = root.kind === "mapping" && root.tag === `${YAML_TAG}set`;
  if (root.kind === "mapping" && !setRoot && root.tag !== `${YAML_TAG}map`) return { kind: "not-built" };
  if (root.kind === "mapping" && !setRoot) return null;
  return { kind: pyValue(root).truthy ? "breaks-build" : "canonical" };
}

/**
 * A stored block as `_parse_page_frontmatter` and the first pass of
 * `generate_pages` read it. `""` is a page with no block, which the
 * Compositor's publish writes with its title, so it is a canonical page.
 */
export function readBlock(block: string): BlockReading {
  if (block === "") return { kind: "canonical" };
  const root = composePyYaml(block);
  if (root === null) return { kind: isEmptyDocument(block) ? "canonical" : "not-built" };
  if (constructionFails(root)) return { kind: "not-built" };
  const notADict = readNonDictRoot(root);
  if (notADict !== null) return notADict;
  const localizedFor = pyValue(mappingValue(root, "localized_for"));
  if (!localizedFor.truthy) return { kind: "canonical" };
  return { kind: "localized", localizedFor, language: pyValue(mappingValue(root, "language")) };
}

/** A page file: its name in the pages folder, its front matter block (`""` for none) and its body. */
export interface PageFile {
  name: string;
  frontmatter: string;
  body: string;
}

/** A file the reduction keeps, with the text it holds afterwards. */
export interface KeptPageFile<F extends PageFile> {
  file: F;
  /** The file whose text it holds: itself, or the file the build served at its address. */
  source: F;
  frontmatter: string;
  body: string;
}

export interface PageFilesReduction<F extends PageFile> {
  /** In name order. */
  kept: KeptPageFile<F>[];
  /** Every file that names a page by `localized_for`, in name order. */
  removed: F[];
}

/** A file the build places at another page's address or skips: it names one, and does not stop the build. */
function namesAnotherPage(reading: BlockReading): reading is Extract<BlockReading, { kind: "localized" }> {
  if (reading.kind !== "localized") return false;
  return !reading.language.truthy || (reading.localizedFor.hashable && reading.language.hashable);
}

/** A top-level `localized_for` or `language` key, bare or quoted. */
const PAGE_LANGUAGE_KEY = /^(["']?)(localized_for|language)\1[ \t]*:(?:[ \t]|\r?\n|$)/;

/** The block without its top-level `localized_for` and `language` lines, each with the lines indented under it. */
function withoutPageLanguageKeys(block: string): string {
  const kept: string[] = [];
  let dropping = false;
  for (const line of block.split(/(?<=\n)/)) {
    if (dropping && /^[ \t]+\S/.test(line)) continue;
    dropping = PAGE_LANGUAGE_KEY.test(line);
    if (!dropping) kept.push(line);
  }
  return kept.join("");
}

/**
 * A block as the front matter of a page of its own: without its
 * `localized_for` and `language` lines when it names another page, else as it
 * is.
 */
export function ownPageFrontmatter(block: string): string {
  return namesAnotherPage(readBlock(block)) ? withoutPageLanguageKeys(block) : block;
}

/** The file the build writes at each page's address, where it is another file. */
function servedFiles<F extends PageFile>(files: readonly F[], readings: Map<F, BlockReading>, siteKey: string): Map<F, F> {
  const pages = new Map<string, F>();
  for (const file of files) if (readings.get(file)!.kind === "canonical") pages.set(file.name, file);
  const served = new Map<F, F>();
  for (const file of files) {
    const reading = readings.get(file)!;
    if (!namesAnotherPage(reading) || reading.language.key !== siteKey) continue;
    const page = reading.localizedFor.string === null ? undefined : pages.get(reading.localizedFor.string);
    if (page !== undefined) served.set(page, file);
  }
  return served;
}

/**
 * A site's page files reduced to one file per page, for a site whose
 * `telar_language` is `siteLanguage`. A page the build serves from another
 * file keeps its own name and takes that file's body and front matter, less
 * its `localized_for` and `language` lines. Every file that names a page by
 * `localized_for` goes, whether or not the build shows it. A served file whose
 * keys are not on lines of their own (a flow mapping, a merge) is left with
 * its page as the build has them.
 */
export function reducePageFiles<F extends PageFile>(files: readonly F[], siteLanguage: unknown): PageFilesReduction<F> {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const readings = new Map(ordered.map((file) => [file, readBlock(file.frontmatter)]));
  const taken = new Map<F, KeptPageFile<F>>();
  for (const [file, source] of servedFiles(ordered, readings, `s:${telarLanguageOf(siteLanguage)}`)) {
    const frontmatter = withoutPageLanguageKeys(source.frontmatter);
    if (readBlock(frontmatter).kind === "canonical") taken.set(file, { file, source, frontmatter, body: source.body });
    // Its keys are not on lines of their own, so it stays a file beside its page.
    else readings.set(source, { kind: "canonical" });
  }
  const removed = ordered.filter((file) => namesAnotherPage(readings.get(file)!));
  const kept = ordered
    .filter((file) => !removed.includes(file))
    .map((file) => taken.get(file) ?? { file, source: file, frontmatter: file.frontmatter, body: file.body });
  return { kept, removed };
}

/** A page as a repository scan reads it, by slug. */
interface ScannedPageFile {
  slug: string;
  title: string;
  frontmatter: string;
  body: string;
}

/**
 * Scanned pages reduced to one file per page (`reducePageFiles`): the pages
 * kept, each with the title, front matter and body of the file the build
 * serves at its address, the names of the files removed, and for each removed
 * file the build serves, the slug of the page it is served at.
 */
export function reduceScannedPages<P extends ScannedPageFile>(
  pages: readonly P[],
  siteLanguage: unknown,
): { pages: P[]; removed: string[]; servedAt: Record<string, string> } {
  const { kept, removed } = reducePageFiles(pages.map((page) => ({ ...page, name: `${page.slug}.md` })), siteLanguage);
  const served = kept.filter((page) => page.source !== page.file);
  return {
    pages: kept.map(({ file, source, frontmatter, body }) => ({ ...file, title: source.title, frontmatter, body })),
    removed: removed.map((file) => file.name),
    servedAt: Object.fromEntries(served.map((page) => [page.source.name, page.file.slug])),
  };
}
