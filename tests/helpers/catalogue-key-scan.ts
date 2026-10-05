/**
 * Finds catalogue keys that no component reaches.
 *
 * The mirror of `jsx-text-scan.ts`: that one closes the direction where text
 * exists with no key, this one closes the direction where a key exists with no
 * text rendering it. `i18n-parity.test.ts` cannot see either — a key present in
 * both locales, spelled correctly and translated, passes it forever whether or
 * not anything renders it.
 *
 * The two errors are not symmetric. Flagging real prose costs a look; calling a
 * live key dead costs a user seeing a raw key on screen. Every rule below is
 * therefore biased toward calling a key live, and the places where that bias
 * blunts the scan are named where they occur.
 *
 * TWO PROBES, WHICH FAIL DIFFERENTLY
 *
 * A key is dead only when both say so.
 *
 *   1. The literal probe parses each source with the TypeScript compiler API
 *      and collects every string literal. It is keyed on the value, not on the
 *      call shape, because keys do not only appear at call sites: `dotConfig`
 *      in `ConnectionPill.tsx` and `labelKeys` in `RoleBadge.tsx` both hold
 *      keys in a lookup table that `t` is handed later. A probe restricted to
 *      `t("…")` and `i18nKey` misses those and reports live keys dead.
 *
 *   2. The text probe searches raw source, so it also catches a key named in a
 *      comment or assembled by concatenation — shapes no parse can resolve.
 *
 * THE TEXT PROBE IS ANCHORED, AND THE ANCHOR IS LOAD-BEARING
 *
 * Unanchored `includes()` rescues any key whose name is a substring of
 * something unrelated, and the something unrelated is usually not a key at all.
 * Measured on this repository, dropping the anchor hides 15 dead keys.
 * Specimens: `publish:summary.stories` is rescued by the property path
 * `summary.stories.new`; `team:section_title` by `course.section_title`, which
 * belongs to another namespace; `objects:type_video` by `media.media_type_video`;
 * `dashboard:new_story` by `new_story_button`; `glossary:see_also` by
 * `drawer.see_also`. A key must therefore sit on a boundary of
 * `[A-Za-z0-9_.]` to count as named.
 *
 * NAMESPACES ARE NOT RESOLVED
 *
 * A reference counts for that key path in EVERY namespace holding it, because
 * resolving `t("title")` to its namespace means tracking the `useTranslation`
 * binding in scope, its array form, its aliases (`tCollab`, `tCommon`), and the
 * `t` passed as a prop. Two namespaces sharing a key path therefore rescue each
 * other. That is the conservative direction, and it is deliberate.
 *
 * PLURALS
 *
 * i18next resolves `t("x", { count })` to `x_one` / `x_other`, so those keys
 * are never named literally. A key ending in a plural suffix is live when its
 * base is referenced. This is mechanical, like `isPunctuationOrSymbolOnly` in
 * the JSX scan, so it lives here rather than in an enumerated list.
 *
 * @version v1.5.0-beta
 */

import ts from "typescript";
import { readFileSync, readdirSync, existsSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

/** One leaf key of one namespace's English catalogue. */
export interface CatalogueKey {
  /** Namespace, i.e. the JSON file's basename (`editor`, `bug-report`). */
  ns: string;
  /** Dot-joined leaf path within that namespace (`media.loop_on`). */
  key: string;
}

/** The trees a running Compositor is built from. Tests are not among them. */
export const SOURCE_ROOTS = ["app", "workers"] as const;

/** i18next's plural-category suffixes, as used by the CLDR rules it ships. */
export const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"] as const;

/** Characters that, flanking a match, mean the text probe found a longer name. */
const KEY_CHARACTER = /[A-Za-z0-9_.]/;

/** Every leaf key path of a nested translation object, dot-joined. */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(...leafKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/**
 * Every key of every English namespace. English is the authority: parity with
 * Spanish is already enforced by `i18n-parity.test.ts`, so a key dead here is
 * dead in both.
 */
export function listCatalogueKeys(repoRoot: string): CatalogueKey[] {
  const enDir = join(repoRoot, "app", "i18n", "locales", "en");
  const out: CatalogueKey[] = [];
  for (const file of readdirSync(enDir).filter((f) => f.endsWith(".json")).sort()) {
    const ns = file.replace(/\.json$/, "");
    const parsed: unknown = JSON.parse(readFileSync(join(enDir, file), "utf-8"));
    for (const key of leafKeys(parsed)) out.push({ ns, key });
  }
  return out;
}

/** The two probes' raw material, gathered once per run. */
export interface SourceIndex {
  /** Every string literal the parser saw, plus each one's post-`ns:` tail. */
  literals: ReadonlySet<string>;
  /** Every scanned file's raw text, concatenated. */
  text: string;
}

/** Build an index from values directly, for fixtures that never touch disk. */
export function makeSourceIndex(literals: Iterable<string>, text: string): SourceIndex {
  const set = new Set<string>();
  for (const literal of literals) {
    set.add(literal);
    if (literal.includes(":")) set.add(literal.slice(literal.indexOf(":") + 1));
  }
  return { literals: set, text };
}

/** Every `.ts`/`.tsx` file under one root, as absolute paths. */
function listSourceFiles(repoRoot: string, rootRel: string): string[] {
  const dir = join(repoRoot, rootRel);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[];
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** Every file both probes read, relative to `repoRoot` with forward slashes. */
export function listScannedSources(repoRoot: string): string[] {
  return SOURCE_ROOTS.flatMap((root) => listSourceFiles(repoRoot, root)).map((abs) =>
    relative(repoRoot, abs).split(sep).join("/"),
  );
}

/** Run both probes' collection pass over the whole source tree. */
export function buildSourceIndex(repoRoot: string): SourceIndex {
  const literals: string[] = [];
  const texts: string[] = [];
  for (const rel of listScannedSources(repoRoot)) {
    const source = readFileSync(join(repoRoot, rel), "utf-8");
    texts.push(source);
    const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        literals.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return makeSourceIndex(literals, texts.join("\n"));
}

/** Probe 1: the key is a string literal somewhere in the parsed source. */
export function namedAsLiteral(index: SourceIndex, key: string): boolean {
  return index.literals.has(key);
}

/**
 * Probe 2: the key appears in raw source on a boundary of key characters, so a
 * longer name that merely contains it does not count.
 */
export function namedInText(index: SourceIndex, key: string): boolean {
  let from = 0;
  for (;;) {
    const at = index.text.indexOf(key, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : index.text[at - 1];
    const afterAt = at + key.length;
    const after = afterAt >= index.text.length ? "" : index.text[afterAt];
    if (!KEY_CHARACTER.test(before) && !KEY_CHARACTER.test(after)) return true;
    from = at + 1;
  }
}

/** Either probe finding the key is enough; a key is dead only when both miss. */
export function isReferenced(index: SourceIndex, key: string): boolean {
  return namedAsLiteral(index, key) || namedInText(index, key);
}

/** True when the key is a plural form of a base that is itself referenced. */
export function resolvesViaPlural(index: SourceIndex, key: string): boolean {
  return PLURAL_SUFFIXES.some(
    (suffix) => key.endsWith(suffix) && isReferenced(index, key.slice(0, -suffix.length)),
  );
}

/** A key nothing reaches by either probe, nor by i18next's plural resolution. */
export function isLive(index: SourceIndex, key: string): boolean {
  return isReferenced(index, key) || resolvesViaPlural(index, key);
}

// ---------------------------------------------------------------------------
// Domain extraction
//
// A family's member set is READ from the code that owns it rather than copied
// beside it. A copy cannot go red the day someone extends the list, which is
// the whole reason a family is asserted rather than excused.
// ---------------------------------------------------------------------------

function parse(repoRoot: string, fileRel: string): ts.SourceFile {
  const abs = join(repoRoot, fileRel);
  return ts.createSourceFile(fileRel, readFileSync(abs, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function findDeclaration(sourceFile: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Unwrap `as const`, `satisfies T`, and parentheses down to the initialiser. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    // `new Set([...])` — the array is the domain, the Set is the container.
    if (ts.isNewExpression(current) && current.arguments?.length === 1) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

/**
 * The string members of an array-valued const. `prop` names the field to read
 * when the elements are object literals (`[{ key: "…" }, …]`).
 */
export function readStringArray(
  repoRoot: string,
  fileRel: string,
  symbol: string,
  prop?: string,
): string[] {
  const declaration = findDeclaration(parse(repoRoot, fileRel), symbol);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    throw new Error(`no array const \`${symbol}\` in ${fileRel}`);
  }
  const array = unwrap(declaration.initializer);
  if (!ts.isArrayLiteralExpression(array)) {
    throw new Error(`\`${symbol}\` in ${fileRel} is not an array literal`);
  }
  const members: string[] = [];
  for (const element of array.elements) {
    const value = unwrap(element);
    if (ts.isStringLiteral(value)) {
      members.push(value.text);
      continue;
    }
    if (prop && ts.isObjectLiteralExpression(value)) {
      for (const member of value.properties) {
        if (
          ts.isPropertyAssignment(member) &&
          member.name.getText() === prop &&
          ts.isStringLiteral(member.initializer)
        ) {
          members.push(member.initializer.text);
        }
      }
    }
  }
  if (members.length === 0) throw new Error(`\`${symbol}\` in ${fileRel} yielded no members`);
  return members;
}

/** One string property of an object-valued const. */
export function readStringProperty(
  repoRoot: string,
  fileRel: string,
  symbol: string,
  prop: string,
): string {
  const declaration = findDeclaration(parse(repoRoot, fileRel), symbol);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    throw new Error(`no const \`${symbol}\` in ${fileRel}`);
  }
  const object = unwrap(declaration.initializer);
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error(`\`${symbol}\` in ${fileRel} is not an object literal`);
  }
  for (const member of object.properties) {
    if (
      ts.isPropertyAssignment(member) &&
      member.name.getText() === prop &&
      ts.isStringLiteral(member.initializer)
    ) {
      return member.initializer.text;
    }
  }
  throw new Error(`\`${symbol}.${prop}\` in ${fileRel} is not a string literal`);
}

/** The string-literal members of a union type alias. */
export function readUnionMembers(repoRoot: string, fileRel: string, symbol: string): string[] {
  const declaration = findDeclaration(parse(repoRoot, fileRel), symbol);
  if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`no type alias \`${symbol}\` in ${fileRel}`);
  }
  const node = declaration.type;
  const types = ts.isUnionTypeNode(node) ? node.types : [node];
  const members: string[] = [];
  for (const type of types) {
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) members.push(type.literal.text);
  }
  if (members.length === 0) throw new Error(`\`${symbol}\` in ${fileRel} yielded no members`);
  return members;
}
