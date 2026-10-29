/**
 * CSRF protection (SPEC §8, AT-83). Two layers:
 *
 * 1. Same-origin check on every state-changing (non GET/HEAD/OPTIONS) `/api/*` request:
 *    the `Origin` header must equal the app origin (APP_URL) or the request's own origin
 *    (see `allowedOrigins`: forwarded host only with TRUST_PROXY, the Host header only outside
 *    production — SEC-7). Without `Origin`, `Sec-Fetch-Site: same-origin` is accepted.
 *    Requests carrying neither (curl, server-to-server) are rejected.
 * 2. Owner API routes additionally require a double-submit token: cookie `oasis_csrf`
 *    (readable by JS, SameSite=Strict, set at login) echoed in header `x-csrf-token`, which the proxy also checks is HMAC-bound to the
 *    caller session (SEC-8).
 *
 * Isomorphic (Web Crypto only) so it runs in the proxy and in route handlers.
 * Client code reads the token with `src/guard/csrf-client.ts`.
 */
import { CSRF_COOKIE, CSRF_HEADER } from "./csrf-client";

export { CSRF_COOKIE, CSRF_HEADER };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export interface CsrfRequestLike {
  method: string;
  url: string;
  headers: Headers;
}

export type CsrfFailure = "origin_mismatch" | "missing_origin" | "token_missing" | "token_mismatch";

export type CsrfResult = { ok: true } | { ok: false; reason: CsrfFailure };

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export interface OriginPolicy {
  /** TRUST_PROXY: honour X-Forwarded-Host / X-Forwarded-Proto (a trusted proxy sets them). */
  trustProxy?: boolean;
  /** NODE_ENV=production: the client-controlled Host header is never trusted. */
  production?: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Origins this request may legitimately come from (SEC-7):
 * - always the APP_URL origin (for a loopback APP_URL also its localhost/127.0.0.1/[::1]
 *   aliases on the same port);
 * - with TRUST_PROXY=true, the origin built from X-Forwarded-Host/-Proto;
 * - outside production only, the request's own Host/URL origin (dev convenience).
 * Production without a trusted proxy therefore accepts the APP_URL origin alone, so
 * client-supplied Host / X-Forwarded-Host headers (DNS rebinding) cannot widen the list.
 */
export function allowedOrigins(
  req: CsrfRequestLike,
  appUrl?: string,
  policy: OriginPolicy = {},
): Set<string> {
  const set = new Set<string>();
  const app = originOf(appUrl);
  if (app) {
    set.add(app);
    const u = new URL(app);
    if (LOOPBACK.has(u.hostname)) {
      for (const h of LOOPBACK) set.add(`${u.protocol}//${h}${u.port ? `:${u.port}` : ""}`);
    }
  }
  if (policy.trustProxy) {
    const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (host) {
      const fwdProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
      const proto = fwdProto === "https" || fwdProto === "http" ? fwdProto : "https";
      const own = originOf(`${proto}://${host}`);
      if (own) set.add(own);
    }
  }
  if (!policy.production) {
    const host = req.headers.get("host");
    const urlOrigin = originOf(req.url);
    if (host) {
      const urlProto = urlOrigin?.split(":")[0] ?? "http";
      const own = originOf(`${urlProto}://${host}`);
      if (own) set.add(own);
    }
    if (urlOrigin) set.add(urlOrigin);
  }
  return set;
}

/** Layer 1: same-origin check. Safe methods always pass. */
export function checkSameOrigin(
  req: CsrfRequestLike,
  appUrl?: string,
  policy: OriginPolicy = {},
): CsrfResult {
  if (isSafeMethod(req.method)) return { ok: true };
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    const o = originOf(origin);
    return o && allowedOrigins(req, appUrl, policy).has(o)
      ? { ok: true }
      : { ok: false, reason: "origin_mismatch" };
  }
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin") return { ok: true };
  if (site) return { ok: false, reason: "origin_mismatch" };
  return { ok: false, reason: "missing_origin" };
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Random URL-safe token (32 bytes). */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read one cookie from a raw `Cookie` header. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/**
 * Layer 2: double-submit token (cookie value must equal header value). With `isBound`
 * (SEC-8), the header must ALSO be the token bound to the caller's session
 * (HMAC(SESSION_SECRET, "csrf:" + sid), checked by the proxy), so a token planted by an
 * attacker who can write cookies does not pass.
 */
export function checkDoubleSubmit(
  req: { headers: Headers },
  isBound?: (token: string) => boolean,
): CsrfResult {
  const cookie = readCookie(req.headers.get("cookie"), CSRF_COOKIE);
  const header = req.headers.get(CSRF_HEADER);
  if (!cookie || !header) return { ok: false, reason: "token_missing" };
  if (cookie.length < 20 || !safeEqual(cookie, header))
    return { ok: false, reason: "token_mismatch" };
  if (isBound && !isBound(header)) return { ok: false, reason: "token_mismatch" };
  return { ok: true };
}

/** Owner API routes that are exempt from the double-submit token (origin check still applies). */
export const OWNER_CSRF_EXEMPT = new Set(["/api/owner/login"]);

export interface CsrfOptions extends OriginPolicy {
  /** Session binding for the owner token (see `checkDoubleSubmit`). */
  isBound?: (token: string) => boolean;
}

/** Full CSRF decision for an API request path. */
export function checkCsrf(
  req: CsrfRequestLike,
  pathname: string,
  appUrl?: string,
  opts: CsrfOptions = {},
): CsrfResult {
  if (isSafeMethod(req.method)) return { ok: true };
  const same = checkSameOrigin(req, appUrl, opts);
  if (!same.ok) return same;
  if (pathname.startsWith("/api/owner/") && !OWNER_CSRF_EXEMPT.has(pathname)) {
    return checkDoubleSubmit(req, opts.isBound);
  }
  return { ok: true };
}
