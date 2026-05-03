/**
 * AES-GCM token encryption/decryption using the Web Crypto API.
 *
 * Designed for Cloudflare Workers (built-in crypto.subtle) and Node.js 18+
 * (globalThis.crypto.subtle). Tokens are encrypted before D1 storage.
 *
 * Pattern: base64(iv[12 bytes] + ciphertext)
 * Key format: 64-character hex string (256-bit / 32-byte key)
 */

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string: odd length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function importKey(
  keyHex: string,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const keyBytes = hexToBytes(keyHex);
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

/**
 * Encrypts a plaintext string with AES-GCM.
 *
 * A random 12-byte IV is generated per call, so identical plaintexts
 * produce different ciphertexts. The IV is prepended to the ciphertext
 * and the whole thing is base64-encoded.
 */
export async function encrypt(
  plaintext: string,
  keyHex: string,
): Promise<string> {
  const cryptoKey = await importKey(keyHex, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoded,
  );
  // Concatenate iv (12 bytes) + ciphertext and base64-encode
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a base64-encoded AES-GCM ciphertext produced by `encrypt`.
 *
 * Throws if the key is wrong or the data is tampered (GCM authentication failure).
 */
export async function decrypt(
  cipherB64: string,
  keyHex: string,
): Promise<string> {
  const cryptoKey = await importKey(keyHex, "decrypt");
  const combined = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plainbytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext,
  );
  return new TextDecoder().decode(plainbytes);
}
