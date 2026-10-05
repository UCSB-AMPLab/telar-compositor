/**
 * order-key.test.ts — the fractional-index key algebra that replaces
 * array-position ordering for stories.
 *
 * The property that matters is the one an integer column cannot give: for any
 * two adjacent keys there is always a third key strictly between them, so a
 * drop between two neighbours never has to renumber anybody. The fuzz case at
 * the bottom is the real test — a thousand random insertions must leave the
 * key list strictly ascending in exactly the intended order.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  BASE_62_DIGITS,
  generateKeyBetween,
  isValidOrderKey,
} from "~/lib/order-key";

describe("BASE_62_DIGITS", () => {
  it("is ASCII-ascending so lexicographic string order matches digit order", () => {
    for (let i = 1; i < BASE_62_DIGITS.length; i++) {
      expect(BASE_62_DIGITS[i - 1] < BASE_62_DIGITS[i]).toBe(true);
    }
    expect(BASE_62_DIGITS).toHaveLength(62);
  });
});

describe("generateKeyBetween — the three unbounded cases", () => {
  it("mints a first key for an empty list", () => {
    expect(generateKeyBetween(null, null)).toBe("a0");
  });

  it("appends after a key without bounding above", () => {
    const first = generateKeyBetween(null, null);
    const second = generateKeyBetween(first, null);
    expect(second > first).toBe(true);
  });

  it("prepends before a key without bounding below", () => {
    const first = generateKeyBetween(null, null);
    const before = generateKeyBetween(null, first);
    expect(before < first).toBe(true);
  });
});

describe("generateKeyBetween — always insertable between neighbours", () => {
  it("finds a key between two adjacent generated keys", () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const mid = generateKeyBetween(a, b);
    expect(a < mid).toBe(true);
    expect(mid < b).toBe(true);
  });

  it("survives 200 successive midpoint insertions into the same gap", () => {
    let lo = generateKeyBetween(null, null);
    const hi = generateKeyBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = generateKeyBetween(lo, hi);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      lo = mid;
    }
  });

  it("keeps appended keys short — the integer part carries the growth", () => {
    let k: string | null = null;
    for (let i = 0; i < 500; i++) k = generateKeyBetween(k, null);
    expect(k!.length).toBeLessThanOrEqual(5);
  });

  it("refuses a reversed or equal pair rather than minting a bad key", () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    expect(() => generateKeyBetween(b, a)).toThrow();
    expect(() => generateKeyBetween(a, a)).toThrow();
  });
});

describe("isValidOrderKey", () => {
  it("accepts generated keys", () => {
    let k: string | null = null;
    for (let i = 0; i < 50; i++) {
      k = generateKeyBetween(k, null);
      expect(isValidOrderKey(k)).toBe(true);
    }
  });

  it("rejects non-strings, the empty string, and malformed keys", () => {
    expect(isValidOrderKey(undefined)).toBe(false);
    expect(isValidOrderKey(null)).toBe(false);
    expect(isValidOrderKey(0)).toBe(false);
    expect(isValidOrderKey("")).toBe(false);
    expect(isValidOrderKey("!!")).toBe(false);
    // Trailing zero in the fractional part is not a canonical key.
    expect(isValidOrderKey("a00")).toBe(false);
  });

  it("accepts the fixed-width form migration 0043 writes", () => {
    // 'a0' integer part + four base-62 rank digits + a '1' terminator.
    expect(isValidOrderKey("a000001")).toBe(true);
    expect(isValidOrderKey("a0000z1")).toBe(true);
  });
});

describe("generateKeyBetween — fuzz: 1000 random insertions stay ordered", () => {
  it("keeps the list strictly ascending in insertion-intended order", () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 0x100000000;
    };

    const keys: string[] = [generateKeyBetween(null, null)];
    for (let i = 0; i < 1000; i++) {
      const at = Math.floor(rand() * (keys.length + 1));
      const lo = at > 0 ? keys[at - 1] : null;
      const hi = at < keys.length ? keys[at] : null;
      const k = generateKeyBetween(lo, hi);
      keys.splice(at, 0, k);
    }

    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});
