/**
 * Finds keys the code asks for that the English catalogue does not hold.
 *
 * The reverse of `catalogue-key-scan.ts`, which finds catalogue keys nothing
 * asks for. `i18n-parity.test.ts` cannot see this direction either: a key
 * missing from both locales is symmetric. A missing key renders as its own
 * name, or as the English `defaultValue` in every language.
 *
 * WHAT COUNTS AS ASKING
 *
 * - A call whose callee is a name a `useTranslation` in scope binds to its
 *   `t`, whatever the name (`t`, `tCommon`, `translate`), or any other name
 *   that looks like one (`t`, `t<Upper>…`), as a `t` passed in as a prop is.
 * - `i18n.t(…)` and `i18next.t(…)`, in the default namespace.
 * - A JSX `i18nKey` attribute (`<Trans>`).
 * Only a key written as a literal is checked. One built at runtime (a template
 * with substitutions, a variable, a lookup table handed to `t` later) is
 * counted as dynamic and not checked.
 *
 * WHERE A KEY IS LOOKED UP
 *
 * As i18next would, as far as the source says. An `ns:` prefix names the
 * namespace. Otherwise an `ns` option on the call (a string, or an array
 * searched in order) does. Otherwise the binding decides: the first namespace
 * of the `useTranslation` that bound the name in the nearest scope, with its
 * `keyPrefix` put in front of the key. The app sets no `fallbackNS`, so the
 * other namespaces of a `useTranslation([...])` are reached only by a prefix
 * or an option. `useTranslation()` and `i18n.t` use the default namespace,
 * `common`. A `<Trans>` uses its `ns` attribute, else the namespace of the
 * `t` it is handed, else `common`.
 *
 * A name that a closer parameter or declaration shadows is untraced, and so
 * is a `t` that arrives as a prop: those are looked up in every namespace.
 * That is the lenient direction. It can pass a key that exists only in
 * another namespace; it cannot report a miss that is not one.
 *
 * WHAT A KEY RESOLVES TO
 *
 * A leaf, exactly. With a `count` option, the English plural forms `_one` and
 * `_other` do as well, since i18next picks one by the count; a count written as
 * a number needs only the form English picks for it, and a count of 0 is also
 * served by `_zero`. Where several namespaces are searched, each form may come
 * from a different one, as i18next finds them. With
 * `returnObjects: true`, a subtree does. With a `context` or `ordinal` option,
 * any leaf that extends the key with `_` does, since the suffix depends on
 * values this scan does not follow.
 *
 * WHERE THE SOURCE DOES NOT SAY
 *
 * Each case below takes the lenient reading, which can pass a key that is
 * wrong and cannot fail one that is right.
 *
 * - Options passed as a variable or with a spread: the key is looked up in
 *   every namespace (unless it carries an `ns:` prefix), and plural, subtree
 *   and suffixed forms all answer.
 * - A `keyPrefix` binding with an `ns` option or an `ns:` prefix on the call:
 *   the key answers with the prefix or without it. A `keyPrefix` option on the
 *   call replaces the binding's; one that is not a literal, or options that
 *   cannot be read, let the key answer under any prefix.
 * - `useTranslation([...], { nsMode: "fallback" })`: every namespace in the
 *   list is searched, in order.
 * - A name bound by a loop, a `catch`, or a function or class declaration
 *   shadows as a declaration does, and is untraced.
 *
 * @version v1.5.0-beta
 */

import ts from "typescript";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { SOURCE_ROOTS, listCatalogueKeys } from "./catalogue-key-scan";

export const DEFAULT_NS = "common";

/** English plural categories: i18next needs both for a count to resolve. */
const ENGLISH_PLURALS = ["_one", "_other"] as const;

/** One key a call asks for, and where it would be looked up. */
export interface KeyReference {
  file: string;
  line: number;
  key: string;
  /** Namespaces searched in order; null means any. */
  namespaces: string[] | null;
  /** The call passes `count`, so the plural forms can answer. */
  plural: boolean;
  /** The count, when the call writes it as a number. */
  count: number | null;
  /** The call passes `returnObjects: true`, so a subtree can answer. */
  subtree: boolean;
  /** A `context` or `ordinal` option: any `key_…` leaf can answer. */
  suffixed: boolean;
  /** Other spellings of the key that answer as well. */
  alternates: string[];
  /** The key prefix is not readable: a leaf with the key under any prefix answers. */
  anyPrefix: boolean;
}

export interface ScanResult {
  references: KeyReference[];
  /** Keys built at runtime, so not readable here. */
  dynamic: number;
}

/** Namespace name → its English leaf keys. */
export type Catalogue = Map<string, Set<string>>;

export function loadEnglishCatalogue(repoRoot: string): Catalogue {
  const out: Catalogue = new Map();
  for (const { ns, key } of listCatalogueKeys(repoRoot)) {
    if (!out.has(ns)) out.set(ns, new Set());
    out.get(ns)!.add(key);
  }
  return out;
}

type Lookable = Pick<KeyReference, "key" | "plural" | "subtree"> &
  Partial<Pick<KeyReference, "count" | "suffixed" | "alternates" | "anyPrefix">>;

const englishPlural = new Intl.PluralRules("en");

/**
 * The plural forms a count needs, each a list of suffixes any one of which
 * serves. An unknown count needs both English forms. A written count needs the
 * form English picks for it, and a count of 0 is also served by `_zero`.
 */
function pluralSlots(count: number | null | undefined): string[][] {
  if (count === null || count === undefined) return ENGLISH_PLURALS.map((suffix) => [suffix]);
  const picked = `_${englishPlural.select(count)}`;
  return [count === 0 ? [picked, "_zero"] : [picked]];
}

/** A leaf that holds the key under some prefix, or extends it. */
function mentions(leaf: string, key: string): boolean {
  return [leaf, `.${leaf}`].some(
    (text) => text.endsWith(`.${key}`) || text.includes(`.${key}.`) || text.includes(`.${key}_`),
  );
}

function leafAnswers(keys: Set<string>, key: string, ref: Lookable): boolean {
  if (keys.has(key)) return true;
  for (const leaf of keys) {
    if (ref.subtree && leaf.startsWith(`${key}.`)) return true;
    if (ref.suffixed && leaf.startsWith(`${key}_`)) return true;
    if (ref.anyPrefix && mentions(leaf, key)) return true;
  }
  return false;
}

/**
 * Whether a reference resolves in the catalogue. The namespaces are searched
 * as i18next searches them, so each plural form may come from a different one.
 */
export function resolves(catalogue: Catalogue, ref: Lookable & Pick<KeyReference, "namespaces">): boolean {
  const sets = (ref.namespaces ?? [...catalogue.keys()])
    .map((ns) => catalogue.get(ns))
    .filter((keys): keys is Set<string> => keys !== undefined);
  const spellings = [ref.key, ...(ref.alternates ?? [])];
  return spellings.some(
    (key) =>
      sets.some((keys) => leafAnswers(keys, key, ref)) ||
      (ref.plural &&
        pluralSlots(ref.count).every((slot) => sets.some((keys) => slot.some((suffix) => keys.has(key + suffix))))),
  );
}

const T_NAME = /^t([A-Z]\w*)?$/;

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isJsxExpression(node)) return literalText(node.expression);
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** A string, or an array of strings, as a namespace list. */
function namespaceList(node: ts.Node | undefined): string[] | null {
  const single = literalText(node);
  if (single !== null) return [single];
  const inner = node && ts.isJsxExpression(node) ? node.expression : node;
  if (inner && ts.isArrayLiteralExpression(inner)) {
    const names = inner.elements.map((e) => literalText(e));
    if (names.length > 0 && names.every((n): n is string => n !== null)) return names;
  }
  return null;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return null;
}

function property(options: ts.Expression | undefined, name: string): ts.Expression | null {
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const p of options.properties) {
    if (ts.isPropertyAssignment(p) && propertyName(p) === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return null;
}

/** A translation function's binding: where its unprefixed keys go. */
interface Binding {
  namespaces: string[];
  keyPrefix: string;
}

/** The binding a `useTranslation(...)` call makes, or null if unreadable. */
function useTranslationBinding(call: ts.CallExpression): Binding | null {
  const [first, options] = call.arguments;
  const namespaces = first ? namespaceList(first) : [DEFAULT_NS];
  if (!namespaces) return null;
  if (options && !plainObject(options)) return null;
  const nsMode = property(options, "nsMode");
  if (nsMode !== null && literalText(nsMode) !== "default") {
    if (literalText(nsMode) !== "fallback") return null;
  } else {
    namespaces.splice(1);
  }
  const prefixNode = property(options, "keyPrefix");
  if (prefixNode === null) return { namespaces, keyPrefix: "" };
  const keyPrefix = literalText(prefixNode);
  return keyPrefix === null ? null : { namespaces, keyPrefix };
}

/** An object literal with no spread, so every option it passes is visible. */
function plainObject(node: ts.Expression): node is ts.ObjectLiteralExpression {
  return ts.isObjectLiteralExpression(node) && node.properties.every((p) => !ts.isSpreadAssignment(p));
}

type Lookup = { kind: "bound"; binding: Binding } | { kind: "untraced" } | { kind: "none" };

/** Every name a binding pattern or identifier declares. */
function declaredNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : declaredNames(e.name)));
}

/** What a variable declaration binds `name` to, if it declares it at all. */
function declarationLookup(decl: ts.VariableDeclaration, name: string): Lookup {
  if (!declaredNames(decl.name).includes(name)) return { kind: "none" };
  const init = decl.initializer;
  const isHook =
    init !== undefined &&
    ts.isCallExpression(init) &&
    ts.isIdentifier(init.expression) &&
    init.expression.text === "useTranslation";
  if (!isHook || !ts.isObjectBindingPattern(decl.name)) return { kind: "untraced" };
  for (const element of decl.name.elements) {
    const bound = element.propertyName ?? element.name;
    if (ts.isIdentifier(element.name) && element.name.text === name) {
      if (!ts.isIdentifier(bound) || bound.text !== "t") return { kind: "untraced" };
      const binding = useTranslationBinding(init as ts.CallExpression);
      return binding ? { kind: "bound", binding } : { kind: "untraced" };
    }
  }
  return { kind: "untraced" };
}

/**
 * What `name` refers to at `from`: walks outwards through the enclosing
 * blocks and functions, and stops at the first declaration or parameter of
 * that name, so a closer binding shadows a farther one.
 */
function lookupName(from: ts.Node, name: string): Lookup {
  for (let node: ts.Node | undefined = from.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (declaredNames(parameter.name).includes(name)) return { kind: "untraced" };
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      if (declaredNames(node.variableDeclaration.name).includes(name)) return { kind: "untraced" };
    }
    if (
      (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      const found = declarationsLookup(node.initializer.declarations, name);
      if (found.kind !== "none") return found;
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      for (const statement of node.statements) {
        const found = statementLookup(statement, name);
        if (found.kind !== "none") return found;
      }
    }
  }
  return { kind: "none" };
}

function declarationsLookup(declarations: readonly ts.VariableDeclaration[], name: string): Lookup {
  for (const decl of declarations) {
    const found = declarationLookup(decl, name);
    if (found.kind !== "none") return found;
  }
  return { kind: "none" };
}

/** What a statement in a block binds `name` to: a variable, or a function or class of that name. */
function statementLookup(statement: ts.Statement, name: string): Lookup {
  if (ts.isVariableStatement(statement)) return declarationsLookup(statement.declarationList.declarations, name);
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
    return { kind: "untraced" };
  }
  return { kind: "none" };
}

interface Placed {
  key: string;
  namespaces: string[] | null;
  alternates: string[];
  anyPrefix: boolean;
}

/**
 * A key and where it is looked up, from the raw key and what the call says.
 * `explicit` is the call's `ns` option; "unknown" when its options cannot be
 * read, which leaves the namespace open.
 */
function place(
  raw: string,
  known: Set<string>,
  explicit: string[] | null | "unknown",
  binding: Binding | null,
  anyPrefix = false,
): Placed {
  if (anyPrefix && binding) binding = { ...binding, keyPrefix: "" };
  const prefixed = (key: string) => (binding?.keyPrefix ? [`${binding.keyPrefix}.${key}`] : []);
  const colon = raw.indexOf(":");
  if (colon > 0 && known.has(raw.slice(0, colon))) {
    const key = raw.slice(colon + 1);
    return { key, namespaces: [raw.slice(0, colon)], alternates: prefixed(key), anyPrefix };
  }
  if (explicit === "unknown") return { key: raw, namespaces: null, alternates: prefixed(raw), anyPrefix };
  if (explicit) return { key: raw, namespaces: explicit, alternates: prefixed(raw), anyPrefix };
  if (binding) {
    const key = binding.keyPrefix ? `${binding.keyPrefix}.${raw}` : raw;
    return { key, namespaces: binding.namespaces, alternates: [], anyPrefix };
  }
  return { key: raw, namespaces: null, alternates: [], anyPrefix };
}


/**
 * `place`, with a `keyPrefix` option on the call. On a bound `t` the option
 * replaces the binding's prefix, and an empty one removes it. On an untraced
 * `t` it applies only if the function is a bound one, so the key answers with
 * the prefix or without it. One that is not a literal lets the key answer
 * under any prefix.
 */
function placeWithCallPrefix(
  raw: string,
  known: Set<string>,
  explicit: string[] | null | "unknown",
  binding: Binding | null,
  prefixNode: ts.Expression | null,
): Placed {
  if (prefixNode === null) return place(raw, known, explicit, binding);
  const keyPrefix = literalText(prefixNode);
  if (keyPrefix === null) return place(raw, known, explicit, binding, true);
  if (binding) return place(raw, known, explicit, { ...binding, keyPrefix });
  const placed = place(raw, known, explicit, null);
  if (keyPrefix) placed.alternates.push(`${keyPrefix}.${placed.key}`);
  return placed;
}

/**
 * The options of a `t` call: its second argument, or its third after a
 * default value. "unknown" when they are passed in a form this scan cannot
 * read, such as a variable or an object with a spread.
 */
function callOptions(call: ts.CallExpression): ts.ObjectLiteralExpression | "unknown" | undefined {
  const [, second, third] = call.arguments;
  const options = second && literalText(second) !== null ? third : second;
  if (!options) return undefined;
  return plainObject(options) ? options : "unknown";
}

/** A number written as a literal, with its sign; null for anything else. */
function numberLiteral(node: ts.Expression | null): number | null {
  if (node === null) return null;
  if (ts.isParenthesizedExpression(node)) return numberLiteral(node.expression);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = numberLiteral(node.operand);
    return inner === null ? null : -inner;
  }
  return null;
}

/** The expression inside a JSX attribute's braces. */
function jsxExpression(node: ts.JsxAttributeValue | undefined): ts.Expression | null {
  return node && ts.isJsxExpression(node) && node.expression ? node.expression : null;
}

function isTrue(node: ts.Expression | null): boolean {
  return node !== null && node.kind === ts.SyntaxKind.TrueKeyword;
}

/** Scan one source text. Exported for fixtures. */
export function scanSource(fileName: string, text: string, knownNamespaces: Set<string>): ScanResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const references: KeyReference[] = [];
  let dynamic = 0;
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  /** `direct` marks `i18n.t`, which ignores a `keyPrefix` option. */
  const recordCall = (call: ts.CallExpression, binding: Binding | null, direct = false): void => {
    const raw = literalText(call.arguments[0]);
    if (raw === null) {
      dynamic++;
      return;
    }
    const options = callOptions(call);
    if (options === "unknown") {
      references.push({
        file: fileName,
        line: lineOf(call),
        ...place(raw, knownNamespaces, "unknown", binding, true),
        plural: true,
        count: null,
        subtree: true,
        suffixed: true,
      });
      return;
    }
    const nsNode = property(options, "ns");
    const explicit = nsNode === null ? null : (namespaceList(nsNode) ?? "unknown");
    const countNode = property(options, "count");
    references.push({
      file: fileName,
      line: lineOf(call),
      ...placeWithCallPrefix(raw, knownNamespaces, explicit, binding, direct ? null : property(options, "keyPrefix")),
      plural: countNode !== null,
      count: numberLiteral(countNode),
      subtree: isTrue(property(options, "returnObjects")),
      suffixed: property(options, "context") !== null || property(options, "ordinal") !== null,
    });
  };

  const visitCall = (call: ts.CallExpression): void => {
    if (call.arguments.length === 0) return;
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      const found = lookupName(call, callee.text);
      if (found.kind === "bound") recordCall(call, found.binding);
      else if (T_NAME.test(callee.text)) recordCall(call, null);
      return;
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "t" &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === "i18n" || callee.expression.text === "i18next")
    ) {
      recordCall(call, { namespaces: [DEFAULT_NS], keyPrefix: "" }, true);
    }
  };

  const visitTrans = (attribute: ts.JsxAttribute): void => {
    const raw = literalText(attribute.initializer);
    if (raw === null) {
      dynamic++;
      return;
    }
    const attributes = attribute.parent.properties;
    const named = (name: string) =>
      attributes.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
      );
    const explicit = namespaceList(named("ns")?.initializer);
    let binding: Binding | null = { namespaces: [DEFAULT_NS], keyPrefix: "" };
    const tAttribute = named("t");
    if (tAttribute) {
      const expression =
        tAttribute.initializer && ts.isJsxExpression(tAttribute.initializer)
          ? tAttribute.initializer.expression
          : undefined;
      const found = expression && ts.isIdentifier(expression) ? lookupName(attribute, expression.text) : null;
      binding = found?.kind === "bound" ? found.binding : null;
    }
    references.push({
      file: fileName,
      line: lineOf(attribute),
      ...place(raw, knownNamespaces, explicit, binding),
      plural: named("count") !== undefined,
      count: numberLiteral(jsxExpression(named("count")?.initializer)),
      subtree: false,
      suffixed: named("context") !== undefined,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) visitCall(node);
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "i18nKey") visitTrans(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { references, dynamic };
}

function sourceFiles(repoRoot: string): string[] {
  return SOURCE_ROOTS.flatMap((root) => {
    const entries = readdirSync(join(repoRoot, root), { recursive: true, withFileTypes: true }) as Dirent[];
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")))
      .map((e) => join(e.parentPath, e.name));
  }).sort();
}

/** Scan the whole running Compositor: `app/` and `workers/`. */
export function scanRepository(repoRoot: string, catalogue: Catalogue): ScanResult {
  const known = new Set(catalogue.keys());
  const references: KeyReference[] = [];
  let dynamic = 0;
  for (const abs of sourceFiles(repoRoot)) {
    const rel = relative(repoRoot, abs).split(sep).join("/");
    const result = scanSource(rel, readFileSync(abs, "utf-8"), known);
    references.push(...result.references);
    dynamic += result.dynamic;
  }
  return { references, dynamic };
}
