/**
 * A YAML block read as the framework's PyYAML reads it: js-yaml composes the
 * node tree, and every node is typed by PyYAML 6.0.3's rules. Shared by the
 * server's title reading (`safeLoadTitle`, yaml.server.ts) and by the page
 * grouping the Pages screen and the collaboration object both run
 * (`app/lib/page-sisters.ts`), which is why it is not a `.server` module.
 *
 * @version v1.5.0-beta
 */

import { load, FAILSAFE_SCHEMA, Type } from "js-yaml";

// ---------------------------------------------------------------------------
// A front matter block as PyYAML's SafeLoader reads it
// ---------------------------------------------------------------------------
//
// The framework parses a layer's block with `yaml.safe_load`, PyYAML 6.0.3 in
// the framework's Python environment (`.venv`, Python 3.14.6). PyYAML is YAML
// 1.1 and js-yaml is YAML 1.2, so they disagree on which plain scalars are strings:
// `yes`, `on` and `1:20` are a boolean and an integer to the framework and
// strings to js-yaml. So js-yaml is used here only to compose the block (the
// node tree: each node's kind, style, explicit tag, anchor and text), under a
// schema with no implicit types that accepts any tag, and every type is then
// decided as PyYAML decides it.

export const YAML_TAG = "tag:yaml.org,2002:";
export const STR_TAG = `${YAML_TAG}str`;

/**
 * The implicit resolvers `yaml.SafeLoader` consults, each with its tag, its
 * pattern and the first characters it is registered under, in registration
 * order: PyYAML 6.0.3 yaml/resolver.py:170-226, `Resolver`, which `SafeLoader`
 * uses. The patterns are the verbose-mode originals with their layout
 * whitespace removed, and each ends `\n?$` where the original ends `$`: in
 * Python, `$` also matches before a final newline, so `regexp.match("1\n")`
 * succeeds for the int resolver and a scalar whose value ends in one line
 * break resolves as though it had none. `""` as a first character is the
 * empty value.
 *
 * `yaml` (resolver.py:223-226) is registered too and is listed for that
 * reason, though PyYAML notes it cannot match: no plain scalar starts with
 * `!`, `&` or `*`.
 */
const PYYAML_IMPLICIT_RESOLVERS: ReadonlyArray<{ tag: string; pattern: RegExp; first: readonly string[] }> = [
  {
    tag: `${YAML_TAG}bool`,
    pattern: /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)\n?$/,
    first: [..."yYnNtTfFoO"],
  },
  {
    tag: `${YAML_TAG}float`,
    pattern:
      /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\n?$/,
    first: [..."-+0123456789."],
  },
  {
    tag: `${YAML_TAG}int`,
    pattern:
      /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)\n?$/,
    first: [..."-+0123456789"],
  },
  { tag: `${YAML_TAG}merge`, pattern: /^(?:<<)\n?$/, first: ["<"] },
  { tag: `${YAML_TAG}null`, pattern: /^(?:~|null|Null|NULL|)\n?$/, first: ["~", "n", "N", ""] },
  {
    tag: `${YAML_TAG}timestamp`,
    pattern:
      /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)\n?$/,
    first: [..."0123456789"],
  },
  { tag: `${YAML_TAG}value`, pattern: /^(?:=)\n?$/, first: ["="] },
  { tag: `${YAML_TAG}yaml`, pattern: /^(?:!|&|\*)\n?$/, first: [..."!&*"] },
];

/**
 * The tag PyYAML's `BaseResolver.resolve` gives a scalar resolved implicitly
 * (resolver.py:143-153): the first resolver registered under the value's first
 * character, or under `""` for the empty value, whose pattern matches; else
 * `str`. A plain scalar goes through this, and so does any scalar tagged with
 * the bare `!`, which PyYAML's parser resolves as though plain.
 */
function pyyamlImplicitTag(value: string): string {
  const first = value === "" ? "" : value[0];
  for (const resolver of PYYAML_IMPLICIT_RESOLVERS) {
    if (resolver.first.includes(first) && resolver.pattern.test(value)) return resolver.tag;
  }
  return STR_TAG;
}

/** The tags `SafeConstructor` can build (PyYAML 6.0.3 constructor.py:431-479). */
const SAFE_CONSTRUCTOR_TAGS: ReadonlySet<string> = new Set(
  ["null", "bool", "int", "float", "binary", "timestamp", "omap", "pairs", "set", "str", "seq", "map"].map(
    (name) => `${YAML_TAG}${name}`,
  ),
);

/** A composed node, typed as PyYAML types it. */
export interface PyYamlNode {
  kind: "scalar" | "sequence" | "mapping";
  /** The PyYAML tag: resolved for an untagged scalar, explicit otherwise. */
  tag: string;
  /** A scalar's text after quoting and folding, as the constructor reads it. */
  text: string;
  children: PyYamlNode[];
}

/** Any tag js-yaml meets is accepted, so composing never fails on one. */
const ANY_TAG_SCHEMA = FAILSAFE_SCHEMA.extend({
  explicit: (["scalar", "sequence", "mapping"] as const).map(
    (kind) => new Type("", { kind, multi: true, resolve: () => true, construct: (data: unknown) => data }),
  ),
});

interface ComposeFrame {
  start: number;
  children: PyYamlNode[];
  /** Each child's value as js-yaml built it, by position in `children`. */
  results: unknown[];
  /** Where each child's text starts and ends, by position in `children`. */
  spans: Array<{ start: number; end: number }>;
}

interface ComposeState {
  position: number;
  kind: string | null;
  tag: string | null;
  result: unknown;
  anchor: string | null;
  input: string;
  anchorMap: Record<string, unknown>;
}

/** A tag and an anchor as js-yaml holds them, either one absent. */
interface NodeProperties {
  tag: string | null;
  anchor: string | null;
}

/** What one composing pass reads and records beyond its stack of frames. */
interface ComposeContext {
  source: string;
  anchors: Map<string, PyYamlNode>;
  /**
   * An alias met while its anchor's node is still open, which is that node
   * containing itself: the node the alias stands for, filled in when the
   * anchored node closes, and where the alias was written.
   */
  pending: Map<string, { node: PyYamlNode; at: number }>;
  /** Properties taken off the start of a key's line, by where the key starts. */
  moved: Map<number, NodeProperties>;
  /** Where each `~` written into an empty block sequence entry stands. */
  filled: ReadonlySet<number>;
  /** Where each `-` of a block sequence entry js-yaml composed no node for stands. */
  empty: number[];
}

/**
 * A block PyYAML's parser or composer refuses and js-yaml reads. The
 * framework treats it as a block that does not load.
 */
class PyYamlRefusal extends Error {}

/** The anchor an alias node names, read from the text where the node starts. */
function aliasName(input: string, start: number): string | null {
  const match = /^[ \t\n]*\*([^\s,[\]{}]+)/.exec(input.slice(start));
  return match ? match[1] : null;
}

/**
 * The start of a block scalar's node: white space, then any tags and anchors
 * (captured) each followed by white space, line breaks or comments, then the
 * `|` or `>` indicator.
 */
const BLOCK_SCALAR_START = /^[ \t\r\n]*((?:[!&][^\s]*(?:[ \t\r\n]|#[^\r\n#]*)+)*)[|>]/;

/**
 * A block scalar's text as PyYAML reads it. js-yaml appends a line break to a
 * document that does not end in one (loader.js `loadDocuments`), so a block
 * scalar that runs to the end of such a document gains a final `\n` PyYAML
 * does not give it: its clip and keep chomping keep only the breaks the text
 * has. The node starts `|` or `>`, after any tag or anchor.
 */
function blockScalarText(text: string, source: string, start: number, end: number): string {
  const block = BLOCK_SCALAR_START.test(source.slice(start));
  const appended = !/[\r\n]$/.test(source) && end >= source.length;
  return block && appended && text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * The PyYAML tag of a node of `kind` whose own tag, as js-yaml holds it, is
 * `tag`: `?` for a plain scalar, `!` for the bare tag, null for none. `empty`
 * is a node js-yaml read nothing for. PyYAML resolves an empty node with no
 * tag, or with the bare `!`, as a plain scalar; any other tag it keeps
 * (composer.py `compose_scalar_node`), so `a: !!str` is the string "".
 */
function pyyamlTag(kind: PyYamlNode["kind"], tag: string | null, text: string, empty: boolean): string {
  if (kind !== "scalar") return tag !== null && tag !== "!" ? tag : `${YAML_TAG}${kind === "mapping" ? "map" : "seq"}`;
  if (tag === "?" || tag === "!" || (empty && tag === null)) return pyyamlImplicitTag(text);
  return tag ?? STR_TAG;
}

/**
 * The node js-yaml composed inside this one and kept as this one, or null.
 * Where a block collection may start, js-yaml's `readBlockMapping` first
 * composes the node as an implicit key, and when no `:` follows it keeps that
 * node as the whole value (loader.js, "Keep the result of `composeNode`"). The
 * outer node then closes with that node as its only child, holding the same
 * value. A root that is a flow collection or a scalar, a block sequence entry,
 * and a node on the line after its key, `?`, `:` or tag all compose this way.
 * PyYAML composes one node there, so the kept node is the node; the outer one
 * contributes only the tag or anchor written before a line break. An alias of
 * the closing node itself holds the same value and is not a kept node.
 */
function keptProbe(state: ComposeState, frame: ComposeFrame, ctx: ComposeContext): PyYamlNode | null {
  if (frame.children.length !== 1 || frame.results[0] !== state.result) return null;
  const probe = frame.children[0];
  if (isStandIn(probe, ctx)) return null;
  return state.kind === null || probe.kind === state.kind ? probe : null;
}

/** Whether `node` stands for an anchored node still open: an alias inside it, not a node js-yaml kept. */
function isStandIn(node: PyYamlNode, ctx: ComposeContext): boolean {
  for (const waiting of ctx.pending.values()) if (waiting.node === node) return true;
  return false;
}

/**
 * The PyYAML type of the node js-yaml just closed. js-yaml marks a plain
 * scalar with the tag `?` and a quoted or block scalar with none (its
 * loader.js `composeNode`); an alias closes with no kind, as does an empty
 * value, and the text at the node's start tells the two apart. A scalar has
 * no children: a node composed inside a block scalar's frame is
 * `readBlockMapping`'s attempt at a key, which found none. Properties taken
 * off the node's line are given to it, and its anchor names it.
 */
function closedNode(recorded: ComposeState, frame: ComposeFrame, ctx: ComposeContext): PyYamlNode {
  const probe = keptProbe(recorded, frame, ctx);
  const state = probe === null ? withBlockScalarProperties(recorded, ctx.source, frame.start) : recorded;
  if (probe !== null) refuseAliasWithProperties(state, frame, ctx.source);
  const node = withMovedProperties(probe ? retagged(probe, state.tag) : ownNode(state, frame, ctx), frame.start, ctx);
  return state.anchor === null ? node : anchored(state.anchor, node, frame.start, ctx);
}

/**
 * The state of a block scalar that js-yaml closed with no tag or anchor
 * though some were written before its line break. Reading the scalar's
 * indicator on the next line, `readBlockMapping` first composes it as an
 * implicit key, and that attempt clears the tag and anchor the outer node
 * had read (loader.js `composeNode` resets both on entry). The properties
 * are read again from the text before the indicator.
 */
function withBlockScalarProperties(state: ComposeState, source: string, start: number): ComposeState {
  if (state.kind !== "scalar" || state.tag !== null || state.anchor !== null) return state;
  const written = BLOCK_SCALAR_START.exec(source.slice(start))?.[1];
  const properties = written ? propertiesOf(written) : null;
  return properties === null ? state : { ...state, tag: properties.tag, anchor: properties.anchor };
}

/**
 * An alias on the line after an anchor or the bare `!`, which js-yaml reads
 * as the aliased node and PyYAML's parser refuses: an alias carries no
 * properties (parser.py `parse_node`). js-yaml refuses any other tag there.
 */
function refuseAliasWithProperties(state: ComposeState, frame: ComposeFrame, source: string): void {
  const withProperties = state.anchor !== null || state.tag !== null;
  if (withProperties && aliasName(source, frame.spans[0].start) !== null) {
    throw new PyYamlRefusal("an alias cannot carry a tag or an anchor");
  }
}

/**
 * `node` named by `name`. PyYAML's composer refuses an anchor named twice in
 * one document (composer.py `compose_node`), and names a collection before
 * composing what it holds, so an alias inside the anchored node stands for
 * the node itself: that alias's stand-in becomes the node here. An alias
 * written before the node's start names nothing yet, which PyYAML refuses.
 */
function anchored(name: string, node: PyYamlNode, start: number, ctx: ComposeContext): PyYamlNode {
  if (ctx.anchors.has(name)) throw new PyYamlRefusal(`found duplicate anchor ${name}`);
  const waiting = ctx.pending.get(name);
  ctx.pending.delete(name);
  if (waiting !== undefined && waiting.at < start) throw new PyYamlRefusal(`found undefined alias ${name}`);
  const target = waiting === undefined ? node : Object.assign(waiting.node, node);
  ctx.anchors.set(name, target);
  return target;
}

/** The node an alias names, or a stand-in for an anchored node still open. */
function aliasTarget(name: string, result: unknown, at: number, ctx: ComposeContext): PyYamlNode {
  const known = ctx.anchors.get(name);
  if (known !== undefined) return known;
  const waiting = ctx.pending.get(name) ?? {
    node: { kind: Array.isArray(result) ? "sequence" : "mapping", tag: "", text: "", children: [] } as PyYamlNode,
    at,
  };
  ctx.pending.set(name, waiting);
  return waiting.node;
}

/** The node that starts where properties were taken off its line, given them. */
function withMovedProperties(node: PyYamlNode, start: number, ctx: ComposeContext): PyYamlNode {
  const moved = ctx.moved.get(start);
  if (moved === undefined) return node;
  ctx.moved.delete(start);
  const tagged = moved.tag === null ? node : { ...node, tag: pyyamlTag(node.kind, moved.tag, node.text, false) };
  return moved.anchor === null ? tagged : anchored(moved.anchor, tagged, start, ctx);
}

function retagged(probe: PyYamlNode, tag: string | null): PyYamlNode {
  return tag === null ? probe : { ...probe, tag: pyyamlTag(probe.kind, tag, probe.text, false) };
}

function ownNode(state: ComposeState, frame: ComposeFrame, ctx: ComposeContext): PyYamlNode {
  const source = ctx.source;
  const alias = state.kind === null ? aliasName(source, frame.start) : null;
  if (alias !== null) return aliasTarget(alias, state.result, frame.start, ctx);
  if (ctx.filled.has(frame.start)) return emptyValue();
  const kind = (state.kind ?? "scalar") as PyYamlNode["kind"];
  const raw = kind === "scalar" && typeof state.result === "string" ? state.result : "";
  const text = blockScalarText(raw, source, frame.start, state.position);
  const tag = pyyamlTag(kind, state.tag, text, state.kind === null);
  if (kind === "scalar") return { kind, tag, text, children: [] };
  if (kind === "mapping") return { kind, tag, text, children: mappingPairs(frame, source) };
  ctx.empty.push(...emptyEntryIndicators(frame, source, state.position));
  return { kind, tag, text, children: sequenceEntries(frame, source) };
}

/** The empty plain scalar PyYAML composes where a node is written with nothing in it. */
function emptyValue(): PyYamlNode {
  return { kind: "scalar", tag: `${YAML_TAG}null`, text: "", children: [] };
}

/** A `-` that starts a block sequence entry: white space or the text's start before it, white space or the end after. */
function isEntryIndicator(source: string, at: number): boolean {
  if (source[at] !== "-") return false;
  const before = at === 0 ? " " : source[at - 1];
  const after = at + 1 >= source.length ? " " : source[at + 1];
  return /[ \t\r\n]/.test(before) && /[ \t\r\n]/.test(after);
}

/** Tags, anchors, white space and comments, then a `-` entry indicator. */
const BLOCK_SEQUENCE_START = /(?:[ \t\r\n]|#[^\n]*|[!&][^ \t\r\n]*)*-(?=[ \t\r\n]|$)/y;

function startsBlockSequence(source: string, start: number): boolean {
  BLOCK_SEQUENCE_START.lastIndex = start;
  return BLOCK_SEQUENCE_START.test(source);
}

/**
 * The entry indicators between two positions. A comment, a `#` at `from` or
 * after white space, runs to the end of its line, and a `-` inside it is not
 * an indicator: counted, it would displace the indicator of the entry after it.
 */
function entryIndicators(source: string, from: number, to: number): number[] {
  const found: number[] = [];
  for (let at = from; at < to; at++) {
    if (source[at] === "#" && (at === from || /[ \t\r\n]/.test(source[at - 1]))) at = lineEnd(source, at, to);
    else if (isEntryIndicator(source, at)) found.push(at);
  }
  return found;
}

/** The position of the line break ending the line `at` is on, or `to`, whichever comes first. */
function lineEnd(source: string, at: number, to: number): number {
  const end = source.indexOf("\n", at);
  return end === -1 || end > to ? to : end;
}

const TAB_AFTER_INDICATOR = /-[ ]*\t/y;

/**
 * A tab after a `-` indicator, before anything else on its line. PyYAML's
 * scanner skips only spaces between tokens and refuses the tab
 * (scanner.py `scan_to_next_token`); js-yaml reads the entry.
 */
function refuseTabAfterIndicator(source: string, at: number): void {
  TAB_AFTER_INDICATOR.lastIndex = at;
  if (TAB_AFTER_INDICATOR.test(source)) throw new PyYamlRefusal("found a tab after a sequence entry indicator");
}

/**
 * Where each `-` of a block sequence stands whose entry js-yaml composed no
 * node for. js-yaml's `readBlockSequence` stores null for an entry with
 * nothing after it on its line and nothing more indented below, without
 * composing a node; PyYAML composes an empty scalar there. Between two
 * entries' nodes, and before the first, the text holds only indicators,
 * properties, white space and comments, and every indicator but the last
 * before a node is such an entry, as is every one after the last node.
 */
function emptyEntryIndicators(frame: ComposeFrame, source: string, end: number): number[] {
  if (!startsBlockSequence(source, frame.start)) return [];
  const empty: number[] = [];
  let from = frame.start;
  const gaps = [...frame.spans.map((span) => ({ to: span.start, next: span.end, own: 1 })), { to: end, next: end, own: 0 }];
  for (const gap of gaps) {
    const found = entryIndicators(source, from, gap.to);
    found.forEach((at) => refuseTabAfterIndicator(source, at));
    empty.push(...found.slice(0, found.length - gap.own));
    from = gap.next;
  }
  return empty;
}

/** The first character at or after `from` that is not white space, a line break or a comment. */
function nextSignificant(source: string, from: number): string {
  const skipped = /^(?:[ \t\r\n]|#[^\n]*)*/.exec(source.slice(from))![0].length;
  return source.charAt(from + skipped);
}

/** The last character before `before` that is not white space or a line break. */
function previousSignificant(source: string, before: number): string {
  let i = before - 1;
  while (i >= 0 && /[ \t\r\n]/.test(source[i])) i--;
  return i < 0 ? "" : source[i];
}

/**
 * A mapping's children as key, value, key, value. js-yaml composes no node
 * for a key written with no value (a flow `{a, b: 1}` or a block `? a` with
 * no `:`: loader.js `readFlowCollection` and `readBlockMapping` store the
 * pair with a null value), and PyYAML composes an empty scalar there. A key
 * has a value node exactly when a `:` follows it.
 */
function mappingPairs(frame: ComposeFrame, source: string): PyYamlNode[] {
  const pairs: PyYamlNode[] = [];
  for (let i = 0; i < frame.children.length; i++) {
    pairs.push(frame.children[i]);
    const valued = i + 1 < frame.children.length && nextSignificant(source, frame.spans[i].end) === ":";
    pairs.push(valued ? frame.children[++i] : emptyValue());
  }
  return pairs;
}

/**
 * A sequence's entries. In a flow sequence, `a: 1` and `? a` are each a
 * mapping of one pair (loader.js `readFlowCollection`), which js-yaml
 * composes as the bare key and value; PyYAML composes the mapping.
 */
function sequenceEntries(frame: ComposeFrame, source: string): PyYamlNode[] {
  const entries: PyYamlNode[] = [];
  for (let i = 0; i < frame.children.length; i++) {
    const valued = i + 1 < frame.children.length && nextSignificant(source, frame.spans[i].end) === ":";
    const explicit = previousSignificant(source, frame.spans[i].start) === "?";
    if (!valued && !explicit) {
      entries.push(frame.children[i]);
      continue;
    }
    const pair = [frame.children[i], valued ? frame.children[++i] : emptyValue()];
    entries.push({ kind: "mapping", tag: `${YAML_TAG}map`, text: "", children: pair });
  }
  return entries;
}

/** A mapping's last direct `key` entry, and the mappings its merge keys bring in, in order. */
function entriesFor(mapping: PyYamlNode, key: string): { direct: PyYamlNode | undefined; merged: PyYamlNode[] } {
  let direct: PyYamlNode | undefined;
  const merged: PyYamlNode[] = [];
  for (let i = 0; i + 1 < mapping.children.length; i += 2) {
    const [k, value] = [mapping.children[i], mapping.children[i + 1]];
    if (k.tag === `${YAML_TAG}merge`) merged.push(...(value.kind === "sequence" ? value.children : [value]));
    else if (k.kind === "scalar" && k.tag === STR_TAG && k.text === key) direct = value;
  }
  return { direct, merged };
}

/**
 * The value `key` has in a mapping once PyYAML's `flatten_mapping`
 * (constructor.py:179-211) has run: the last direct `key`, else the first
 * merged mapping carrying one. A merged mapping is read the same way, so a
 * merge inside a merge is followed. A mapping already searched is not searched
 * again, which ends a merge of a mapping that contains itself.
 */
export function mappingValue(mapping: PyYamlNode, key: string, searched = new Set<PyYamlNode>()): PyYamlNode | undefined {
  if (mapping.kind !== "mapping" || searched.has(mapping)) return undefined;
  searched.add(mapping);
  const { direct, merged } = entriesFor(mapping, key);
  if (direct !== undefined) return direct;
  for (const m of merged) {
    const found = mappingValue(m, key, searched);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Whether `SafeConstructor` fails on this tree, which makes `safe_load` raise
 * and the framework fall back to the raw capture (markdown.py:121-124, :139):
 * a tag it has no constructor for (`construct_undefined`, constructor.py:426),
 * which includes a `merge` or `value` scalar anywhere but a key; a merge key
 * whose value is not a mapping or a sequence of mappings (constructor.py:
 * 192-204). A `value` key is rewritten to `str` and constructs
 * (constructor.py:205-207).
 */
export function constructionFails(node: PyYamlNode, asKey = false, checked = new Set<PyYamlNode>()): boolean {
  const keyTag = asKey && (node.tag === `${YAML_TAG}value` || node.tag === `${YAML_TAG}merge`);
  if (!keyTag && !SAFE_CONSTRUCTOR_TAGS.has(node.tag)) return true;
  if (checked.has(node)) return false;
  checked.add(node);
  return node.children.some((_, i) => childFails(node, i, checked));
}

/** Whether the child at `i` fails, or is a merge key whose value SafeConstructor refuses. */
function childFails(node: PyYamlNode, i: number, checked: Set<PyYamlNode>): boolean {
  const key = node.kind === "mapping" && i % 2 === 0;
  if (constructionFails(node.children[i], key, checked)) return true;
  return key && node.children[i].tag === `${YAML_TAG}merge` && badMergeValue(node.children[i + 1]);
}

function badMergeValue(value: PyYamlNode | undefined): boolean {
  if (!value) return true;
  if (value.kind === "mapping") return false;
  return value.kind !== "sequence" || value.children.some((c) => c.kind !== "mapping");
}

/**
 * The text a pass composes, the properties taken off its keys' lines by where
 * each key starts in it, and where in the block each such line starts.
 */
interface PassInput {
  source: string;
  moved: Map<number, NodeProperties>;
  lines: Map<number, number>;
}

/**
 * A pass's root and the empty entries it found, or why it has none: "stray"
 * lists where properties taken off a line found no node starting.
 */
type PassResult = { root: PyYamlNode | null; empty: number[] } | { stray: number[] } | "refused" | "unread";

/** A value no alias composes to, standing for an anchor js-yaml was not shown. */
const MOVED_ANCHOR = Object.freeze({});

/** One composition of `input.source`: "unread" where js-yaml throws, "refused" where PyYAML would. */
function composePass(input: PassInput, filled: ReadonlySet<number>): PassResult {
  const stack: ComposeFrame[] = [{ start: 0, children: [], results: [], spans: [] }];
  const ctx: ComposeContext = { source: input.source, anchors: new Map(), pending: new Map(), moved: new Map(input.moved), filled, empty: [] };
  try {
    load(input.source, {
      schema: ANY_TAG_SCHEMA,
      json: true,
      // js-yaml's typings declare only part of the state its listener gets;
      // the fields read here are the loader's own (loader.js `State`).
      listener(event, loaderState) {
        const state = loaderState as unknown as ComposeState;
        if (event === "open") {
          if (stack.length === 1 && stack[0].children.length === 0) declareMovedAnchors(state, input.moved);
          stack.push({ start: state.position, children: [], results: [], spans: [] });
          return;
        }
        const frame = stack.pop() as ComposeFrame;
        const parent = stack[stack.length - 1];
        parent.children.push(closedNode(state, frame, ctx));
        parent.results.push(state.result);
        parent.spans.push({ start: frame.start, end: state.position });
      },
    });
  } catch (error) {
    return error instanceof PyYamlRefusal ? "refused" : "unread";
  }
  if (ctx.moved.size > 0) return { stray: [...ctx.moved.keys()] };
  return { root: stack[0].children[0] ?? null, empty: ctx.empty };
}

/** Lets js-yaml read an alias of an anchor taken off a key's line. */
function declareMovedAnchors(state: ComposeState, moved: Map<number, NodeProperties>): void {
  for (const { anchor } of moved.values()) {
    if (anchor !== null) state.anchorMap[anchor] = MOVED_ANCHOR;
  }
}

/**
 * A line's indentation and entry indicators, the properties at its start,
 * and the rest. PyYAML refuses properties before an alias or before a `-` or
 * `?` indicator, so a line whose rest starts with one is left as written. It
 * also refuses a tab between tokens, so only spaces follow a property here.
 */
const LINE_START_PROPERTIES = /^([ \t]*(?:-[ \t]+)*)((?:[!&][^ \t\r\n]*[ ]+)+)(?!\*|[?-](?:[ \t]|$))([^ \t\r\n][^\r\n]*)$/gm;

/** The tag and anchor a run of properties gives a node, as js-yaml reads them, or null where it cannot. */
function propertiesOf(written: string): NodeProperties | null {
  let found: NodeProperties | null = null;
  try {
    load(`${written}x`, {
      schema: ANY_TAG_SCHEMA,
      listener(event, loaderState) {
        const state = loaderState as unknown as ComposeState;
        if (event === "close") found = { tag: state.tag === "?" ? null : state.tag, anchor: state.anchor };
      },
    });
  } catch {
    return null;
  }
  return found;
}

/**
 * The block with the properties removed from the start of each line that
 * holds a key, except the lines starting at `kept`, and each set of
 * properties by where the node after it then starts. PyYAML gives properties
 * written before an implicit key on its line to the key (its scanner opens
 * the mapping at the first property). js-yaml gives them to the mapping
 * instead, and then refuses the first key of a block mapping, because a block
 * mapping cannot start on the line of its own properties. Removing them keeps
 * the key's column, which is the mapping's indentation. A line with no `:`
 * holds no key, and its properties stay: after properties on the line above,
 * they are a second set on one node, which PyYAML refuses.
 */
function movedKeyProperties(text: string, kept: ReadonlySet<number>): PassInput | null {
  const moved = new Map<number, NodeProperties>();
  const lines = new Map<number, number>();
  let removed = 0;
  const source = text.replace(LINE_START_PROPERTIES, (line, lead: string, written: string, rest: string, offset: number) => {
    const properties = !kept.has(offset) && /:(?:[ \t]|$)/.test(rest) ? propertiesOf(written) : null;
    if (properties === null) return line;
    const start = offset - removed + lead.length;
    moved.set(start, properties);
    lines.set(start, offset);
    removed += written.length;
    return lead + rest;
  });
  return moved.size === 0 ? null : { source, moved, lines };
}

/**
 * A block js-yaml refuses, composed with properties moved off its keys'
 * lines. A line whose properties find no node starting after them is inside
 * a scalar, and is composed again as written.
 */
function composeMoved(text: string): { input: PassInput; pass: PassResult } | null {
  const kept = new Set<number>();
  for (;;) {
    const input = movedKeyProperties(text, kept);
    if (input === null) return null;
    const pass = composePass(input, new Set());
    if (typeof pass === "string" || !("stray" in pass)) return { input, pass };
    for (const start of pass.stray) kept.add(input.lines.get(start)!);
  }
}

/**
 * The block with a `~` written into each empty block sequence entry, where
 * each `~` stands, and the moved properties' positions shifted to match.
 * js-yaml nests a line after an empty entry by that entry's indentation, not
 * the line's own, so `- -\n- x` reads with `x` inside the inner sequence;
 * with each entry holding a node, every line nests by its own indentation.
 * The `~` nodes compose as the empty scalar PyYAML gives such an entry.
 */
function withEmptyEntriesFilled(input: PassInput, empty: number[]): PassInput & { filled: Set<number> } {
  const at = [...new Set(empty)].sort((a, b) => a - b);
  const pieces: string[] = [];
  const filled = new Set<number>();
  let from = 0;
  at.forEach((p, k) => {
    pieces.push(input.source.slice(from, p + 1), " ~");
    filled.add(p + 2 * k + 2);
    from = p + 1;
  });
  pieces.push(input.source.slice(from));
  const moved = new Map<number, NodeProperties>();
  let before = 0;
  for (const [position, properties] of [...input.moved].sort((a, b) => a[0] - b[0])) {
    while (before < at.length && at[before] < position) before++;
    moved.set(position + 2 * before, properties);
  }
  return { source: pieces.join(""), moved, lines: new Map(), filled };
}

/**
 * The block's root node as PyYAML composes it, or null where PyYAML refuses
 * the block or js-yaml cannot read it. A block js-yaml refuses is read again
 * with properties moved off its keys' lines, and a block with empty sequence
 * entries is read again with each entry filled.
 */
export function composePyYaml(text: string): PyYamlNode | null {
  let read: { input: PassInput; pass: PassResult } | null = {
    input: { source: text, moved: new Map(), lines: new Map() },
    pass: "unread",
  };
  read.pass = composePass(read.input, new Set());
  if (read.pass === "unread") read = composeMoved(text);
  if (read === null || typeof read.pass === "string" || "stray" in read.pass) return null;
  if (read.pass.empty.length === 0) return read.pass.root;
  return filledRoot(read.input, read.pass);
}

/**
 * The root composed again with each empty entry filled, or the first pass's
 * root where the filled text does not read. The first pass's tree lacks only
 * the empty entries, and a filled text that fails to read is a `-` taken for
 * an indicator that is not one.
 */
function filledRoot(input: PassInput, first: { root: PyYamlNode | null; empty: number[] }): PyYamlNode | null {
  const filled = withEmptyEntriesFilled(input, first.empty);
  const second = composePass(filled, filled.filled);
  return typeof second === "string" || "stray" in second ? first.root : second.root;
}

const BOOL_TAG = `${YAML_TAG}bool`;
/** The texts PyYAML's bool constructor reads as true (constructor.py `bool_values`), lower-cased. */
const PYYAML_TRUE = new Set(["yes", "true", "on"]);

/** Whether a node loads as the boolean true, as PyYAML's bool constructor reads it. */
export function isPyYamlTrue(node: PyYamlNode | undefined): boolean {
  return node?.tag === BOOL_TAG && PYYAML_TRUE.has(node.text.toLowerCase());
}

/** The `google_sheets` node of a `_config.yml` that loads under `safe_load`, else undefined. */
export function googleSheetsBlock(configYml: string): PyYamlNode | undefined {
  const root = composePyYaml(configYml);
  if (root === null || constructionFails(root)) return undefined;
  return mappingValue(root, "google_sheets");
}

/**
 * Whether the build fetches Google Sheets for this `_config.yml`. build.yml
 * prints `config.get('google_sheets', {}).get('enabled', False)` from the
 * file as `safe_load` reads it, and fetches when the shell's capture of that
 * output, trailing line breaks removed, is exactly `True`. So it is on for the
 * boolean true (`true`, `yes` and `on` in any of their YAML 1.1 spellings) and
 * for a string whose text is `True` followed by nothing but line breaks, such
 * as a quoted "True"; off for any other value, a quoted "true" included, a
 * missing key, a `google_sheets` that is not a mapping, and a file that does
 * not load.
 */
export function isGoogleSheetsOn(configYml: string): boolean {
  const block = googleSheetsBlock(configYml);
  const enabled = block && mappingValue(block, "enabled");
  if (isPyYamlTrue(enabled)) return true;
  return enabled?.kind === "scalar" && enabled.tag === STR_TAG && enabled.text.replace(/\n+$/, "") === "True";
}

/** A copy of the node tree with the node at `google_sheets.enabled` replaced by a fixed marker. */
function withSheetsEnabledMarked(configYml: string): string | null {
  const root = composePyYaml(configYml);
  if (root === null) return null;
  const copy = structuredClone(root);
  const block = mappingValue(copy, "google_sheets");
  const enabled = block && mappingValue(block, "enabled");
  if (enabled) Object.assign(enabled, { kind: "scalar", tag: "marker", text: "", children: [] });
  return JSON.stringify(copy);
}

/**
 * Whether two `_config.yml` texts load to the same tree under PyYAML's rules
 * except for the value of `google_sheets.enabled`, which is not compared. A
 * text that does not load is never the same.
 */
export function sameExceptSheetsEnabled(before: string, after: string): boolean {
  const [a, b] = [withSheetsEnabledMarked(before), withSheetsEnabledMarked(after)];
  return a !== null && a === b;
}
