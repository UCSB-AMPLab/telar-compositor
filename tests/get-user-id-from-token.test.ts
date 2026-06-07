/**
 * Unit tests for getUserIdFromToken in workers/auth.ts.
 *
 * Covers the fail-closed lifetime guard: a token whose HMAC verifies but whose
 * payload carries NEITHER an `expires` nor a `createdAt` field has no
 * enforceable lifetime and must be rejected. Tokens with at least one of the
 * two fields (and a valid userId) must still resolve.
 */

import { describe, it, expect } from "vitest";
import { getUserIdFromToken } from "../workers/auth";

const TEST_SECRET = "test-session-secret";

/** Encode bytes as base64url (no padding), matching the cookie token shape. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a `<base64url(JSON)>.<base64url(HMAC-SHA256)>` token with a valid HMAC
 * over the given payload, signed with `secret`.
 */
async function mintToken(
  payload: Record<string, unknown>,
  secret: string = TEST_SECRET,
): Promise<string> {
  const enc = new TextEncoder();
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  const sigB64 = base64urlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

function minutesFromNow(n: number): string {
  return new Date(Date.now() + n * 60 * 1000).toISOString();
}

describe("getUserIdFromToken — lifetime fail-closed guard", () => {
  it("rejects a valid-HMAC token that has neither expires nor createdAt", async () => {
    const token = await mintToken({ userId: 7 });

    const result = await getUserIdFromToken(token, TEST_SECRET);

    expect(result).toBeNull();
  });

  it("accepts a valid token with only createdAt (recent) set", async () => {
    const token = await mintToken({
      userId: 7,
      createdAt: new Date().toISOString(),
    });

    const result = await getUserIdFromToken(token, TEST_SECRET);

    expect(result).toBe(7);
  });

  it("accepts a valid token with only expires (future) set", async () => {
    const token = await mintToken({
      userId: 7,
      expires: minutesFromNow(60),
    });

    const result = await getUserIdFromToken(token, TEST_SECRET);

    expect(result).toBe(7);
  });

  it("accepts a normal token carrying both expires and createdAt", async () => {
    const token = await mintToken({
      userId: 7,
      expires: minutesFromNow(60),
      createdAt: new Date().toISOString(),
    });

    const result = await getUserIdFromToken(token, TEST_SECRET);

    expect(result).toBe(7);
  });

  it("rejects a token whose createdAt is older than the 7-day window", async () => {
    const token = await mintToken({
      userId: 7,
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await getUserIdFromToken(token, TEST_SECRET);

    expect(result).toBeNull();
  });
});
