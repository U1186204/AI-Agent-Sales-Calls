/**
 * Owner password hashing (scrypt, node:crypto only).
 *
 * Format: `scrypt$N$r$p$<salt b64>$<hash b64>` — self-describing so parameters can be raised
 * later without breaking existing hashes. Passwords are never stored anywhere but the
 * OWNER_PASSWORD_HASH env var.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLen, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(
  password: string,
  params: { N?: number; r?: number; p?: number } = {},
): Promise<string> {
  if (password.length === 0) throw new Error("Password must not be empty");
  const N = params.N ?? SCRYPT_DEFAULTS.N;
  const r = params.r ?? SCRYPT_DEFAULTS.r;
  const p = params.p ?? SCRYPT_DEFAULTS.p;
  const salt = randomBytes(SCRYPT_DEFAULTS.saltLen);
  const key = await scryptAsync(password, salt, SCRYPT_DEFAULTS.keyLen, {
    N,
    r,
    p,
    maxmem: 256 * N * r,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nS, rS, pS, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  // N must be a power of two > 1; cap work factors to avoid DoS via a hostile config value.
  if (!Number.isInteger(N) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(saltB64, "base64");
  const hash = Buffer.from(hashB64, "base64");
  if (salt.length < 8 || hash.length < 16) return null;
  return { N, r, p, salt, hash };
}

/** Constant-time verify. Returns false (never throws) for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let key: Buffer;
  try {
    key = await scryptAsync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 256 * parsed.N * parsed.r,
    });
  } catch {
    return false;
  }
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}
