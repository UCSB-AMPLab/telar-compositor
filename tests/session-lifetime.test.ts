/**
 * Unit tests for isSessionLifetimeValid — the shared server-side session
 * lifetime guard used by BOTH auth paths (the websocket auth in
 * workers/auth.ts getUserIdFromToken AND the HTTP auth middleware), so a
 * session token's enforceable lifetime is checked consistently everywhere.
 *
 * Rule: reject when past `expires`, reject when `createdAt` is older than the
 * 7-day window (matches the cookie maxAge), and fail closed when a token
 * carries NEITHER field (no enforceable lifetime).
 */

import { describe, it, expect } from "vitest";
import { isSessionLifetimeValid } from "../workers/auth";

const NOW = 1_700_000_000_000; // fixed reference instant
const DAY = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("isSessionLifetimeValid", () => {
  it("accepts a token with a recent createdAt", () => {
    expect(isSessionLifetimeValid(iso(NOW - DAY), undefined, NOW)).toBe(true);
  });

  it("accepts a token with a future expires", () => {
    expect(isSessionLifetimeValid(undefined, iso(NOW + DAY), NOW)).toBe(true);
  });

  it("rejects a token carrying neither createdAt nor expires (no enforceable lifetime)", () => {
    expect(isSessionLifetimeValid(undefined, undefined, NOW)).toBe(false);
  });

  it("rejects a token whose createdAt is older than 7 days", () => {
    expect(isSessionLifetimeValid(iso(NOW - 8 * DAY), undefined, NOW)).toBe(false);
  });

  it("accepts a createdAt right at the edge (just under 7 days)", () => {
    expect(isSessionLifetimeValid(iso(NOW - 7 * DAY + 1000), undefined, NOW)).toBe(true);
  });

  it("rejects a token whose expires is in the past", () => {
    expect(isSessionLifetimeValid(iso(NOW - DAY), iso(NOW - 1000), NOW)).toBe(false);
  });
});
