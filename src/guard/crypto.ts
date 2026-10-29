/**
 * Field encryption + keyed hashing (SPEC §5, AT-84).
 *
 * - `encryptString` / `decryptString`: AES-256-GCM, 12-byte random IV, 16-byte tag.
 *   Wire format: `v1:<iv b64>:<tag b64>:<ciphertext b64>` (standard base64).
 *   Key: env `OASIS_ENCRYPTION_KEY` (32 random bytes, base64). Decryption throws
 *   `CryptoError` on any tampering, truncation, wrong key, or unknown version.
 * - `hmacLookup`: HMAC-SHA256 (hex) keyed by env `OASIS_HMAC_KEY` — deterministic, used for
 *   equality lookups on encrypted data (Customer.emailHash). Callers normalize first.
 * - `generateReference`: `<PREFIX>-XXXX-XXXX` from a 32-char unambiguous alphabet
 *   (no 0/O/1/I), crypto-random and unbiased. Orders AND bookings both use the `OAS`
 *   prefix because the shared `Reference` contract (status lookup) pins `OAS-`; the record
 *   type is resolved by table. Escalation tickets use `ESC`.
 *
 * Every function accepts an optional explicit key so tests can exercise wrong-key paths.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { getEnv } from "@/config/env";
import { REFERENCE_ALPHABET } from "@/config/constants";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

let cachedKey: { source: string; key: Buffer } | null = null;

/** Decode a base64 32-byte key (throws CryptoError if malformed). */
export function decodeKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new CryptoError("Encryption key must be 32 bytes (base64)");
  return key;
}

function envKey(): Buffer {
  const source = getEnv().OASIS_ENCRYPTION_KEY;
  if (cachedKey?.source !== source) cachedKey = { source, key: decodeKey(source) };
  return cachedKey.key;
}

export function encryptString(plaintext: string, key: Buffer = envKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptString(payload: string, key: Buffer = envKey()): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new CryptoError("Unsupported ciphertext");
  const iv = Buffer.from(parts[1] ?? "", "base64");
  const tag = Buffer.from(parts[2] ?? "", "base64");
  const ct = Buffer.from(parts[3] ?? "", "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError("Malformed ciphertext");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new CryptoError("Decryption failed (tampered data or wrong key)");
  }
}

/** True when a string looks like our ciphertext envelope (used by AT-84 checks). */
export function isEncrypted(value: string): boolean {
  return /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/.test(value);
}

export function encryptJson(value: unknown, key?: Buffer): string {
  return encryptString(JSON.stringify(value), key);
}

export function decryptJson<T = unknown>(payload: string, key?: Buffer): T {
  return JSON.parse(decryptString(payload, key)) as T;
}

/** HMAC-SHA256(value) as lower-case hex, keyed by OASIS_HMAC_KEY (raw string bytes). */
export function hmacLookup(value: string, hmacKey: string = getEnv().OASIS_HMAC_KEY): string {
  return createHmac("sha256", hmacKey).update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/**
 * 128-bit crypto-random id, base64url (22 chars). Used for ids that act as bearer handles
 * (conversations, checkout drafts — SEC-11) instead of Prisma's predictable `cuid()`.
 */
export function randomId(): string {
  return randomBytes(16).toString("base64url");
}

/** `<PREFIX>-XXXX-XXXX`, e.g. `OAS-7K2M-Q9XD`. Prefix is upper-cased A–Z only. */
export function generateReference(prefix = "OAS"): string {
  const p = prefix.toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(p)) throw new CryptoError("Reference prefix must be 2-6 letters");
  const block = () =>
    Array.from({ length: 4 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join(
      "",
    );
  return `${p}-${block()}-${block()}`;
}
