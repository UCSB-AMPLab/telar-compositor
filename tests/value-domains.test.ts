/**
 * The shape and semantic halves of the value-domain class.
 *
 * `renderedValue` closed the render half: a value nothing can convert to a
 * primitive now reads as absent instead of throwing inside the snapshot batch.
 * Two forms were left. The server still ASSUMES A SHAPE — `x as Y.Array` then
 * `.get(i).get(...)` — which is a `TypeError` on the plain JSON Yjs stores
 * verbatim at any key or any array position. And it still INTERPRETS values
 * semantically without a domain: `if (v)` reads the string `"false"` as true,
 * so a setting turned off persists as on.
 *
 * These tests pin the primitives both fixes are built from. Two properties
 * carry the weight:
 *
 * 1. `missing` and `wrong_type` are DIFFERENT answers. A reader that returns
 *    `null` for both reads a malformed `steps` as a story with no steps, and
 *    the snapshot then deletes every step row in D1. The distinction is what
 *    keeps a denial of service from being answered with data loss.
 *
 * 2. Guarding a CONTAINER does not guard its ELEMENTS. A genuine `Y.Array`
 *    holding a plain object passes every `instanceof Y.Array` guard in the
 *    server and throws on the line after it.
 *
 * The refused value is never rendered — a plant is reported by type and
 * position, never by content.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  entityMaps,
  readCoordinate,
  readFlag,
  readHumanKey,
  readRowId,
  readYArray,
  readYMap,
  readYText,
  typeNameOf,
} from "../app/lib/value-domains";
import { isIdentityValueInDomain } from "../workers/can-delete";

/** A value that converts to no primitive at all — `String(it)` throws. */
const UNRENDERABLE = JSON.parse('{"toString": null}') as unknown;

describe("typeNameOf", () => {
  it("names a type without converting the value to one", () => {
    // The point of the whole helper: this input makes `String(...)` throw.
    expect(() => String(UNRENDERABLE)).toThrow(TypeError);
    expect(typeNameOf(UNRENDERABLE)).toBe("plain-object");
  });

  it("separates the kinds a log reader has to tell apart", () => {
    expect(typeNameOf(undefined)).toBe("undefined");
    expect(typeNameOf(null)).toBe("null");
    expect(typeNameOf("x")).toBe("string");
    expect(typeNameOf(1)).toBe("number");
    expect(typeNameOf(false)).toBe("boolean");
    expect(typeNameOf({})).toBe("plain-object");
    expect(typeNameOf([])).toBe("plain-array");
    expect(typeNameOf(new Y.Text())).toBe("Y.Text");
    expect(typeNameOf(new Y.Array())).toBe("Y.Array");
    expect(typeNameOf(new Y.Map())).toBe("Y.Map");
  });

  it("never names the value", () => {
    expect(typeNameOf("victim-slug")).toBe("string");
    expect(typeNameOf(["victim-slug"])).toBe("plain-array");
  });

  it("does not name a shared type it cannot model as one it can", () => {
    // `Y.XmlText extends Y.Text` and `Y.XmlHook extends Y.Map`, so a name
    // taken by `instanceof` reports both as kinds the mirror handles. A
    // subdocument matches neither and is an object, so it would read as a
    // plain one. Both are shared values and neither is one of the three.
    expect(typeNameOf(new Y.XmlText())).toBe("shared-type");
    expect(typeNameOf(new Y.XmlElement())).toBe("shared-type");
    expect(typeNameOf(new Y.XmlFragment())).toBe("shared-type");
    expect(typeNameOf(new Y.Doc())).toBe("shared-type");
  });
});

describe("missing is not wrong_type", () => {
  it("reads an unset key as missing and a malformed one as wrong_type", () => {
    expect(readYArray(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(readYArray({})).toEqual({
      ok: false,
      reason: "wrong_type",
      found: "plain-object",
    });
  });

  it("does not read a null container as absence — the key is present", () => {
    // `map.set("steps", null)` leaves `has("steps")` true and survives the
    // yjs_state round trip. Reading it as absence answers "this story has no
    // steps", and the reconciler deletes every step row on that answer.
    const ydoc = new Y.Doc();
    const map = ydoc.getMap<unknown>("story");
    ydoc.transact(() => map.set("steps", null));
    const round = new Y.Doc();
    Y.applyUpdate(round, Y.encodeStateAsUpdate(ydoc));
    const carried = round.getMap<unknown>("story");
    expect(carried.has("steps")).toBe(true);

    expect(readYArray(carried.get("steps"))).toEqual({
      ok: false,
      reason: "wrong_type",
      found: "null",
    });
    expect(readYMap(null)).toEqual({ ok: false, reason: "wrong_type", found: "null" });
    expect(readYText(null)).toEqual({ ok: false, reason: "wrong_type", found: "null" });
  });

  it("still reads null as unset for a nullable column, which is a fact about the field", () => {
    // `created_by`, `x`, `y`, `zoom` are nullable in D1 and genuinely unset
    // when null. Whether null means absence is a question about the field.
    expect(readRowId(null)).toEqual({ ok: false, reason: "missing" });
    expect(readCoordinate(null)).toEqual({ ok: false, reason: "missing" });
    expect(readHumanKey(null)).toEqual({ ok: false, reason: "missing" });
    expect(readFlag(null)).toEqual({ ok: false, reason: "missing" });
  });

  it("distinguishes them for every reader, which is what a caller branches on", () => {
    const readers = [readYMap, readYArray, readYText, readRowId, readHumanKey, readCoordinate, readFlag];
    for (const read of readers) {
      const absent = read(undefined);
      const malformed = read(Symbol("no") as unknown as never);
      expect(absent.ok).toBe(false);
      expect(malformed.ok).toBe(false);
      expect(absent.ok === false && absent.reason).toBe("missing");
      expect(malformed.ok === false && malformed.reason).toBe("wrong_type");
    }
  });
});

describe("shape readers", () => {
  it("accept only the genuine shared type", () => {
    const map = new Y.Map();
    const arr = new Y.Array();
    const text = new Y.Text();
    expect(readYMap(map)).toEqual({ ok: true, value: map });
    expect(readYArray(arr)).toEqual({ ok: true, value: arr });
    expect(readYText(text)).toEqual({ ok: true, value: text });
  });

  it("refuse the plain JSON that answers false to instanceof and still looks right", () => {
    // A plain array has `.length` and passes a truthiness guard; it has no
    // `.get`, which is the throw.
    expect(readYArray([]).ok).toBe(false);
    expect(readYMap({}).ok).toBe(false);
    // A plain string at a Y.Text key: `yTextToString` renders it, which is
    // right for a column, and a caller about to call a Y.Text method must not.
    expect(readYText("prose").ok).toBe(false);
  });

  it("refuses an unrenderable value without rendering it", () => {
    const result = readYMap(UNRENDERABLE);
    expect(result).toEqual({
      ok: false,
      reason: "wrong_type",
      found: "plain-object",
    });
  });
});

describe("readRowId agrees with the identity domain", () => {
  const cases: unknown[] = [
    1, 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2, "1", [1], {}, true, new Y.Text(),
  ];

  it("returns a value for exactly the values isIdentityValueInDomain accepts", () => {
    for (const value of cases) {
      // `_id` is the identity domain's own key; the reader restates that rule
      // and the two must not drift.
      expect(readRowId(value).ok).toBe(isIdentityValueInDomain("_id", value));
    }
  });

  it("reads absence as missing, as the identity domain does", () => {
    expect(readRowId(undefined).ok).toBe(false);
    expect(isIdentityValueInDomain("_id", undefined)).toBe(true);
    expect(readRowId(null)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("readHumanKey", () => {
  it("takes a non-empty string and nothing else", () => {
    expect(readHumanKey("pot-01")).toEqual({ ok: true, value: "pot-01" });
    expect(readHumanKey("").ok).toBe(false);
    expect(readHumanKey(["pot-01"]).ok).toBe(false);
    expect(readHumanKey(new Y.Text("pot-01")).ok).toBe(false);
  });

  it("constrains the KIND and never the content, so renaming still works", () => {
    expect(readHumanKey("a brand new slug 2026").ok).toBe(true);
  });
});

describe("readCoordinate", () => {
  it("takes a finite number", () => {
    expect(readCoordinate(0)).toEqual({ ok: true, value: 0 });
    expect(readCoordinate(-2.5)).toEqual({ ok: true, value: -2.5 });
  });

  it("refuses the numbers a viewport cannot use", () => {
    expect(readCoordinate(NaN).ok).toBe(false);
    expect(readCoordinate(Infinity).ok).toBe(false);
    expect(readCoordinate("3").ok).toBe(false);
  });
});

describe("readFlag — the third form", () => {
  it("reads the string 'false' as out of domain, not as true", () => {
    // `if (v)` reads this as ON. That is a setting the user turned off,
    // persisted as on.
    expect(Boolean("false")).toBe(true);
    expect(readFlag("false").ok).toBe(false);
  });

  it("reads an empty object and an empty array as out of domain, not as true", () => {
    expect(Boolean({})).toBe(true);
    expect(Boolean([])).toBe(true);
    expect(readFlag({}).ok).toBe(false);
    expect(readFlag([]).ok).toBe(false);
  });

  it("takes a real boolean", () => {
    expect(readFlag(true)).toEqual({ ok: true, value: true });
    expect(readFlag(false)).toEqual({ ok: true, value: false });
  });
});

describe("entityMaps — the element guard", () => {
  it("a real Y.Array holding a plain object passes instanceof and throws on the next line", () => {
    const ydoc = new Y.Doc();
    const stories = ydoc.getArray<unknown>("stories");
    ydoc.transact(() => {
      stories.push([{ _id: 1 }]);
    });

    // The guard every existing traversal uses.
    expect(stories instanceof Y.Array).toBe(true);
    // The line after it.
    expect(() =>
      (stories.get(0) as Y.Map<unknown>).get("steps"),
    ).toThrow(TypeError);
  });

  it("returns the genuine maps and the positions of what it skipped", () => {
    const ydoc = new Y.Doc();
    const stories = ydoc.getArray<unknown>("stories");
    const good = new Y.Map<unknown>();
    const alsoGood = new Y.Map<unknown>();
    ydoc.transact(() => {
      stories.push([good]);
      stories.push([{ _id: 1 }]);
      stories.push(["a string"]);
      stories.push([alsoGood]);
    });

    const { maps, skipped } = entityMaps(stories);
    expect(maps).toEqual([good, alsoGood]);
    expect(skipped).toEqual([1, 2]);
  });

  it("is total: nothing throws, whatever it is handed", () => {
    for (const input of [undefined, null, {}, [], "x", 1, UNRENDERABLE, new Y.Map()]) {
      expect(() => entityMaps(input)).not.toThrow();
      expect(entityMaps(input)).toEqual({ maps: [], skipped: [] });
    }
  });

  it("reports positions and never elements, so a detection can be logged safely", () => {
    const ydoc = new Y.Doc();
    const stories = ydoc.getArray<unknown>("stories");
    ydoc.transact(() => {
      stories.push([{ secret: "victim-slug" }]);
    });
    const { skipped } = entityMaps(stories);
    expect(skipped).toEqual([0]);
    expect(JSON.stringify(skipped)).not.toContain("victim");
  });
});
