/**
 * Field domains for the values a collaborator can write into the document.
 *
 * Yjs stores plain JSON verbatim. A value at a map key or an array position is
 * whatever the client put there — `{}`, `[]`, `"false"`, a number, an object
 * that converts to no primitive at all — and it survives the `yjs_state` round
 * trip untouched. Server code that assumes otherwise fails in three ways: it
 * RENDERS the value to decide something (`String(v)`, which throws on some
 * values), it ASSUMES A SHAPE and calls a method on it (`v.toArray()`, a
 * `TypeError`), or it INTERPRETS the value semantically with no domain at all
 * (`if (v)`, which reads the string `"false"` as true).
 *
 * The answer to all three is the same and it is not a smarter reader: every
 * client-writable value gets a field-specific domain before it is interpreted,
 * traversed, or persisted. `isIdentityValueInDomain` established that
 * discipline for the identity keys; this module is the rest of it.
 *
 * The module is shared rather than worker-local because the document is
 * shared: `app/lib/field-order.ts` traverses the same arrays the Durable
 * Object does, and a guard that only one of them applies is not a guard.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

/**
 * The result of reading a document value against a field's domain.
 *
 * `missing` and `wrong_type` are separate answers and the separation is the
 * whole point. Collapsing them to `null` reads a malformed value as an absent
 * one, and absent has a meaning: a story with no `steps` key has no steps, so
 * every step row in D1 is an orphan and the snapshot deletes it. A `steps` key
 * holding a plain object is not a story with no steps — it is a story whose
 * steps the server cannot read, and the only safe reading of "cannot read" is
 * to leave D1's rows alone. One answer means delete; the other must never.
 *
 * `found` names the TYPE and never the value. A refused value is refused
 * precisely because rendering it is unsafe, and a log line that renders it
 * hands the plant back to whoever placed it, so a response carries positions
 * rather than values.
 */
export type Read<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "wrong_type"; found: string };

const MISSING: Read<never> = { ok: false, reason: "missing" };

/**
 * True for any live shared type or subdocument. Such a value belongs to the
 * document it is integrated in and cannot be copied by assignment: yjs
 * REINTEGRATES it, so writing one into a second place throws.
 *
 * This is the one definition of the predicate. It lives here rather than
 * beside its first caller because both the guard layer and the snapshot decide
 * what a shared value is, and a rule two modules state separately is two rules.
 */
export function isSharedValue(value: unknown): boolean {
  return value instanceof Y.AbstractType || value instanceof Y.Doc;
}

/**
 * The name of a shared value: one of the three types this codebase models, by
 * EXACT constructor, and `shared-type` for every other shared value.
 *
 * `Y.XmlText extends Y.Text` and `Y.XmlHook extends Y.Map`, so a name taken by
 * `instanceof` says a value is a kind the mirror handles when it is not, and a
 * subdocument is an object that matches neither. Default-deny answers the
 * whole space at once, including any type a future yjs adds.
 *
 * The constructor read is guarded because a name must be total: the value is
 * client-authored and a log line is never worth a throw.
 */
function sharedTypeName(value: unknown): string {
  let ctor: unknown;
  try {
    ctor = (value as { constructor?: unknown }).constructor;
  } catch {
    return "shared-type";
  }
  if (ctor === Y.Text) return "Y.Text";
  if (ctor === Y.Array) return "Y.Array";
  if (ctor === Y.Map) return "Y.Map";
  return "shared-type";
}

/**
 * The type of a value, for a log line, without converting it to one.
 *
 * `typeof` alone cannot separate a plain object from an array from a Yjs
 * shared type, and those are exactly the distinctions a reader of the log
 * needs. A value with a hostile `toString`, a throwing getter or a null
 * prototype names itself as safely as any other.
 */
export function typeNameOf(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (isSharedValue(value)) return sharedTypeName(value);
  if (Array.isArray(value)) return "plain-array";
  const primitive = typeof value;
  if (primitive === "object") return "plain-object";
  if (primitive === "function") return "function";
  return primitive;
}

function wrongType(value: unknown): Read<never> {
  return { ok: false, reason: "wrong_type", found: typeNameOf(value) };
}

/**
 * The structural readers below take `undefined` as absence and NOTHING else —
 * `null` included.
 *
 * `map.set("steps", null)` leaves `map.has("steps")` true, and the null
 * survives the `yjs_state` round trip, so the key is PRESENT and holds a value
 * that is not a container. Reading it as absence would answer "this story has
 * no steps", and the reconciler acts on that answer by deleting every step row
 * D1 holds — the exact deletion this whole distinction exists to prevent,
 * reintroduced through the one value that looks like nothing.
 *
 * Whether `null` means absence is a question about the field, not about
 * `null`: a nullable column such as `created_by` or `x` genuinely is unset
 * when it is null, and those readers below keep reading it that way.
 */

/** A shared map, or the reason it is not one. */
export function readYMap(value: unknown): Read<Y.Map<unknown>> {
  if (value === undefined) return MISSING;
  return value instanceof Y.Map ? { ok: true, value } : wrongType(value);
}

/** A shared array, or the reason it is not one. */
export function readYArray(value: unknown): Read<Y.Array<unknown>> {
  if (value === undefined) return MISSING;
  return value instanceof Y.Array ? { ok: true, value } : wrongType(value);
}

/**
 * A shared text, or the reason it is not one.
 *
 * This does NOT replace `yTextToString`, and the two must not be folded
 * together: `yTextToString` is the total render bound for the prose columns and
 * answers "what string does this key read as", which for a plain string is
 * that string. This answers "does this key really hold a Y.Text", which the
 * places that are about to call a Y.Text method need and a renderer does not.
 */
export function readYText(value: unknown): Read<Y.Text> {
  if (value === undefined) return MISSING;
  return value instanceof Y.Text ? { ok: true, value } : wrongType(value);
}

/**
 * The `Y.Text` a character-merged config key holds, by EXACT constructor.
 *
 * `readYText` is the `instanceof` reading, which a `Y.XmlText` satisfies. That
 * is right where the question is "can I call a Y.Text method on this" and
 * wrong where it is "is this the value the config page's editor binds to":
 * only a real `Y.Text` is, and an XML type at one of these keys arrived by a
 * route no editor offers.
 *
 * Absence is the ABSENT KEY and nothing else. A cleared `title` is a title of
 * `""`, which is what a key no client ever set writes too, so `undefined` is
 * `missing`. Every value that is present is read as a value: `null` is a
 * present value that is not a `Y.Text`, so it is `wrong_type`, and the column
 * it stands at keeps what D1 holds rather than being blanked by a value the
 * config page's editor cannot have written.
 */
export function readConfigYText(value: unknown): Read<Y.Text> {
  if (value === undefined) return MISSING;
  return (value as { constructor?: unknown })?.constructor === Y.Text
    ? { ok: true, value: value as Y.Text }
    : wrongType(value);
}

/**
 * The characters a shared text holds, whatever subclass holds them.
 *
 * `Y.Text.toString()` is the render for the exact type and the fast path here.
 * A subclass renders through its own code and states more than characters:
 * `Y.XmlText` converts every embed to a string, so an embed reads as
 * `[object Object]` and one converting to no primitive throws, and it
 * serialises formatting as markup, so text marked bold reads `<bold>x</bold>`.
 * A prose column is a CSV cell the site publishes verbatim; both of those are
 * rubbish in it, and both pass a test that asks only whether the value is a
 * `Y.Text`.
 *
 * The delta states each run of the content separately, so keeping the string
 * inserts and dropping the rest gives the subclass the reading `Y.Text`
 * already has: characters, no embeds, no markup. On an exact `Y.Text` the two
 * paths agree by construction, which is why the fast path may take the cheaper
 * one.
 */
export function proseString(text: Y.Text): string {
  if (text.constructor === Y.Text) return text.toString();
  let out = "";
  for (const op of text.toDelta()) {
    if (typeof op.insert === "string") out += op.insert;
  }
  return out;
}

/**
 * The prose an entity key holds: the string it renders as, or the reason it
 * renders none.
 *
 * In domain: a `Y.Text` by `instanceof`, which admits every subclass, and a
 * plain string, which `useCollaborativeText` keeps on screen when the bind is
 * null. Nothing else.
 *
 * The test is STRUCTURAL: it asks what the value is, never what it shows. A
 * `Y.Text` holding only an embed renders `""` and is accepted as an empty
 * value, which CLEARS the column; what is held is what no bind can read at
 * all.
 *
 * `instanceof`, deliberately, and NOT the exact constructor `readConfigYText`
 * takes: `replaceYText` mutates any `instanceof Y.Text` in place rather than
 * replacing a subclass, so a subclass refused here would be edited by every
 * write and persisted by none, and an accepted sync change would return as
 * the same diff on every read.
 *
 * The render is `proseString`, which states the characters and nothing else.
 * It is still wrapped, because `toDelta` is the value's own code on a
 * subclass and a throw there reaches the snapshot batch, which then persists
 * nothing for the whole project. A `Y.Text` that cannot state a string states
 * none, which is `wrong_type` like any other value this cannot read.
 *
 * Absence is the ABSENT KEY and nothing else, on the same terms as
 * `readConfigYText`: a cleared `title` is a title of `""`. `null` is a present
 * value that is not prose.
 */
export function readProse(value: unknown): Read<string> {
  if (value === undefined) return MISSING;
  if (typeof value === "string") return { ok: true, value };
  if (!(value instanceof Y.Text)) return wrongType(value);
  try {
    return { ok: true, value: proseString(value) };
  } catch {
    return wrongType(value);
  }
}

/**
 * A plain string at a config key, read as one.
 *
 * Empty is in domain and is how the config page clears one of these fields, so
 * this is deliberately not `readHumanKey`: an empty `url` is a site with no
 * address stated, which is a setting rather than an unreadable value.
 */
export function readConfigString(value: unknown): Read<string> {
  if (value === undefined || value === null) return MISSING;
  return typeof value === "string" ? { ok: true, value } : wrongType(value);
}

/**
 * A D1 row id: a positive safe integer, the domain
 * `isIdentityValueInDomain` states for `_id`, restated here as a reader rather
 * than a predicate. The two must agree, so this is deliberately the same three
 * conditions and nothing more — a second, subtly different definition of the
 * same rule is how the identity pass and the ingest boundary would drift
 * apart.
 */
export function readRowId(value: unknown): Read<number> {
  if (value === undefined || value === null) return MISSING;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : wrongType(value);
}

/**
 * A human key — slug, `_temp_id`, `order_key`, any identifier the document
 * carries as a string. Empty is not a key: the dedupe pass skips empty keys
 * precisely because two entities that both state nothing are not thereby the
 * same entity, and the same reasoning makes `""` out of domain here.
 */
export function readHumanKey(value: unknown): Read<string> {
  if (value === undefined || value === null) return MISSING;
  return typeof value === "string" && value.length > 0
    ? { ok: true, value }
    : wrongType(value);
}

/**
 * A coordinate bound to a REAL column — `x`, `y`, `zoom`. Finite excludes
 * `NaN` and the infinities, which SQLite stores but which no viewport can use
 * and no client should be able to write.
 */
export function readCoordinate(value: unknown): Read<number> {
  if (value === undefined || value === null) return MISSING;
  return typeof value === "number" && Number.isFinite(value)
    ? { ok: true, value }
    : wrongType(value);
}

/**
 * A boolean, read as one.
 *
 * The third form of the class lives here: a document value tested for truth
 * with `if (v)` reads `{}` as true, `[]` as true, and the string `"false"` as
 * **true** — so a setting the user turned off persists as on. Only an actual
 * boolean is in domain; a caller that needs to accept `"true"`/`"false"` from
 * a legacy document must say so at its own site rather than widen this.
 */
export function readFlag(value: unknown): Read<boolean> {
  if (value === undefined || value === null) return MISSING;
  return typeof value === "boolean" ? { ok: true, value } : wrongType(value);
}

/**
 * The genuine entity maps in a container, and the positions of what was
 * skipped. Total: no input throws, including one that is not a container at
 * all.
 *
 * Guarding a container with `instanceof Y.Array` does NOT guard its elements.
 * Yjs stores plain JSON verbatim at an array position exactly as it does at a
 * map key, so a real `Y.Array` can hold `{}`, and the next line — `.get(i)`
 * then `.get("steps")` — is a `TypeError` on a value the server never
 * validated. Inside the snapshot batch that throw rejects the whole batch, and
 * the document stays open and editable while it does. Every traversal goes
 * through this, so there is one place where an element is checked rather than
 * one per call site.
 *
 * `skipped` carries indices, not elements: a caller that logs a detection must
 * be able to say where without saying what.
 */
export function entityMaps(
  container: unknown,
): { maps: Y.Map<unknown>[]; skipped: number[] } {
  const maps: Y.Map<unknown>[] = [];
  const skipped: number[] = [];
  if (!(container instanceof Y.Array)) return { maps, skipped };
  for (let i = 0; i < container.length; i++) {
    const member = container.get(i);
    if (member instanceof Y.Map) maps.push(member);
    else skipped.push(i);
  }
  return { maps, skipped };
}

/* ------------------------------------------------------------------ *
 * Column binds
 * ------------------------------------------------------------------ */

/**
 * A value handed to `.bind()` is a value handed to SQLite, and SQLite takes
 * `null`, a number, a string, a bigint or bytes and nothing else. Every one of
 * these columns was bound by casting the document's value to the type the
 * column wanted — `as number | null`, `as string | null` — which is a claim
 * TypeScript checks at compile time about a value that only exists at run
 * time, and the value is whatever a collaborator wrote.
 *
 * So the cast is replaced by the column's domain. A value outside it binds
 * NULL, which is the column's own unset state and the row this project would
 * have written before anyone put the value there — the reading `renderedValue`
 * already takes for the string columns, kept the same here so the two do not
 * have to be reasoned about separately.
 *
 * Only `_id` is exempt, and deliberately: an out-of-domain row id is not bound
 * as NULL but sent through the adopt-or-reinsert branch, because NULL there
 * would mint a second row for an entity that already has one.
 */

/** `order_key`: the entity's place in its list, or NULL when it has none. */
export function orderKeyBind(yMap: Y.Map<unknown>): string | null {
  const read = readHumanKey(yMap.get("order_key"));
  return read.ok ? read.value : null;
}

/** A foreign key to `users` — `created_by`, and any other row reference. */
export function rowIdBind(value: unknown): number | null {
  const read = readRowId(value);
  return read.ok ? read.value : null;
}

/** A REAL column a viewport reads back: `x`, `y`, `zoom`. */
export function coordinateBind(value: unknown): number | null {
  const read = readCoordinate(value);
  return read.ok ? read.value : null;
}

/**
 * An INTEGER column standing for a boolean.
 *
 * These were bound as `v ? 1 : 0`, which reads the string `"false"` as 1. A
 * value outside the domain binds 0 — every one of these columns defaults off,
 * so 0 is both the column's unset state and the safe reading: `private`,
 * `draft` and `image_available` all withhold rather than expose when unset.
 */
export function flagBind(value: unknown): 0 | 1 {
  const read = readFlag(value);
  return read.ok && read.value ? 1 : 0;
}
