import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "~/lib/crypto.server";

// Generate a 256-bit test key (64 hex chars)
const TEST_KEY =
  "a1b2c3d4e5f60708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

const WRONG_KEY =
  "b2c3d4e5f60708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021";

describe("crypto.server", () => {
  it("encrypt produces a non-empty base64 string", async () => {
    const result = await encrypt("hello", TEST_KEY);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => atob(result)).not.toThrow();
  });

  it("decrypt(encrypt(plaintext, key), key) returns the original plaintext", async () => {
    const plaintext = "hello";
    const ciphertext = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(ciphertext, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypt produces different ciphertexts for same plaintext (random IV)", async () => {
    const plaintext = "hello";
    const ciphertext1 = await encrypt(plaintext, TEST_KEY);
    const ciphertext2 = await encrypt(plaintext, TEST_KEY);
    expect(ciphertext1).not.toBe(ciphertext2);
  });

  it("decrypt with wrong key throws or returns null", async () => {
    const ciphertext = await encrypt("hello", TEST_KEY);
    await expect(decrypt(ciphertext, WRONG_KEY)).rejects.toBeDefined();
  });

  it("round-trip works with longer plaintext (token-like string)", async () => {
    const token =
      "gho_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const ciphertext = await encrypt(token, TEST_KEY);
    const decrypted = await decrypt(ciphertext, TEST_KEY);
    expect(decrypted).toBe(token);
  });
});
