/**
 * Owner session token: `<payload b64url>.<HMAC-SHA256 b64url>`, payload `{u, sid, iat, exp}`
 * (epoch seconds). Signed with SESSION_SECRET. No Next.js imports, so the proxy can verify it.
 *
 * SEC-4: a valid signature is not enough. The token's random `sid` must also be ACTIVE in the
 * server-side session store (`./session-store`): logout revokes it, so a copied cookie stops
 * working immediately. `exp` is capped at issue time + SESSION_TTL_SEC on verify, so a forged
 * or tampered far-future `exp` is rejected even with a valid signature.
 *
 * SEC-8: the CSRF double-submit token is HMAC(SESSION_SECRET, "csrf:" + sid) — bound to the
 * session, so a planted `oasis_csrf` cookie cannot match.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "oasis_owner";
export const SESSION_TTL_SEC = 8 * 60 * 60;
/** Clock skew tolerated between `iat`/`exp` and the server clock. */
const SKEW_SEC = 60;

export interface OwnerSession {
  /** Owner username. */
  u: string;
  /** Random session id (revocable server-side). */
  sid: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function newSessionId(): string {
  return randomBytes(16).toString("base64url");
}

export function signSession(
  username: string,
  secret: string,
  opts: { nowSec?: number; ttlSec?: number; sid?: string } = {},
): { token: string; session: OwnerSession } {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(opts.ttlSec ?? SESSION_TTL_SEC, SESSION_TTL_SEC);
  const session: OwnerSession = {
    u: username,
    sid: opts.sid ?? newSessionId(),
    iat: now,
    exp: now + ttl,
  };
  const payload = b64url(Buffer.from(JSON.stringify(session), "utf8"));
  return { token: `${payload}.${b64url(sign(payload, secret))}`, session };
}

/**
 * Returns the session when the signature is valid, it is not expired, and its lifetime is
 * within SESSION_TTL_SEC; otherwise null. Does NOT check revocation (see session-store).
 */
export function verifySession(
  token: string | null | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): OwnerSession | null {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = sign(payload, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Partial<OwnerSession>;
    if (
      typeof s.u !== "string" ||
      typeof s.sid !== "string" ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(s.sid) ||
      typeof s.iat !== "number" ||
      typeof s.exp !== "number" ||
      !Number.isFinite(s.iat) ||
      !Number.isFinite(s.exp)
    ) {
      return null;
    }
    if (s.exp <= nowSec) return null;
    // Cap the lifetime: never longer than the TTL, never issued in the future.
    if (s.iat > nowSec + SKEW_SEC) return null;
    if (s.exp - s.iat > SESSION_TTL_SEC || s.exp > nowSec + SESSION_TTL_SEC + SKEW_SEC) return null;
    return { u: s.u, sid: s.sid, iat: s.iat, exp: s.exp };
  } catch {
    return null;
  }
}

/** CSRF token bound to a session id (SEC-8). URL-safe, 43 chars. */
export function csrfTokenForSession(sid: string, secret: string): string {
  return b64url(sign(`csrf:${sid}`, secret));
}

/** Constant-time comparison of a presented CSRF token with the session-bound one. */
export function csrfTokenMatches(presented: string | null, sid: string, secret: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(csrfTokenForSession(sid, secret), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
