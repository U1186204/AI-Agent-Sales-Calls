/**
 * Owner authentication (SPEC §8, AT-70).
 *
 * - `verifyOwnerCredentials` — constant-time username compare + scrypt verify against
 *   OWNER_PASSWORD_HASH. Always runs scrypt, so a wrong username takes as long as a wrong
 *   password.
 * - Session cookie `oasis_owner`: HMAC-SHA256-signed `{u, sid, iat, exp}`, 8 h (capped on
 *   verify), HttpOnly, SameSite=Strict, Secure in production (except on a localhost APP_URL),
 *   Path=/. The `sid` must be active in the server-side session store: logout revokes it.
 * - CSRF cookie `oasis_csrf` = HMAC(SESSION_SECRET, "csrf:" + sid): a double-submit token
 *   bound to the session (the proxy recomputes it from the session cookie).
 * - `getOwnerSession(cookies)`, `requireOwner()` (server components: redirects to
 *   /owner/login), `requireOwnerApi(request)` (route handlers: 401 Response).
 * - Login throttling lives in guard/rate-limit (`checkLoginRateLimit` 5 / 15 min / IP, plus
 *   the IP-independent `loginGuard()`). A browser that signed in before carries the signed
 *   `oasis_device` cookie (`./device-token`, R2-3), which bypasses the IP-independent parts.
 */
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/config/env";
import { CSRF_COOKIE } from "@/guard/csrf";
import { verifyPassword } from "./password";
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_PATH,
  DEVICE_TTL_SEC,
  signDeviceToken,
  verifyDeviceToken,
  type DeviceToken,
} from "./device-token";
import { activateSession, isSessionActive, revokeSession } from "./session-store";
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  csrfTokenForSession,
  signSession,
  verifySession,
  type OwnerSession,
} from "./session-token";

export { SESSION_COOKIE, SESSION_TTL_SEC, signSession, verifySession, type OwnerSession };
export { DEVICE_COOKIE, DEVICE_TTL_SEC, signDeviceToken, verifyDeviceToken, type DeviceToken };
export {
  activateSession,
  isSessionActive,
  revokeSession,
  resetSessionStore,
} from "./session-store";
export const OWNER_LOGIN_PATH = "/owner/login";

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Constant-time string equality (hashes first so lengths never leak). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export async function verifyOwnerCredentials(username: string, password: string): Promise<boolean> {
  const env = getEnv();
  const userOk = constantTimeEqual(username.trim(), env.OWNER_USERNAME);
  const passOk = await verifyPassword(password, env.OWNER_PASSWORD_HASH);
  return userOk && passOk;
}

/** True while OWNER_PASSWORD_HASH is the shipped demo hash (dashboard shows a banner). */
export function isDemoOwnerPassword(): boolean {
  return getEnv().demo.ownerPassword;
}

/** Whether cookies get the `Secure` flag. */
export function secureCookies(): boolean {
  const env = getEnv();
  if (env.NODE_ENV !== "production") return false;
  try {
    const host = new URL(env.APP_URL).hostname;
    // Browsers treat http://localhost as a secure context inconsistently (Safari); keep local
    // production builds usable. Any real host gets Secure.
    return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]");
  } catch {
    return true;
  }
}

export interface CookieSpec {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    sameSite: "strict";
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

/** Build the session + CSRF cookies for a successful login. */
export function createOwnerSessionCookies(username: string): {
  session: OwnerSession;
  csrfToken: string;
  cookies: [CookieSpec, CookieSpec];
} {
  const env = getEnv();
  const { token, session } = signSession(username, env.SESSION_SECRET);
  activateSession(session.sid, session.exp);
  const csrfToken = csrfTokenForSession(session.sid, env.SESSION_SECRET);
  const secure = secureCookies();
  return {
    session,
    csrfToken,
    cookies: [
      {
        name: SESSION_COOKIE,
        value: token,
        options: { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: SESSION_TTL_SEC },
      },
      {
        name: CSRF_COOKIE,
        value: csrfToken,
        options: {
          httpOnly: false,
          sameSite: "strict",
          secure,
          path: "/",
          maxAge: SESSION_TTL_SEC,
        },
      },
    ],
  };
}

/** The 30-day signed "known device" cookie, set on every successful sign-in (R2-3). */
export function createKnownDeviceCookie(username: string): CookieSpec {
  const { token } = signDeviceToken(username, getEnv().SESSION_SECRET);
  return {
    name: DEVICE_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookies(),
      path: DEVICE_COOKIE_PATH,
      maxAge: DEVICE_TTL_SEC,
    },
  };
}

/**
 * The verified known-device token from the request cookies, only when it was issued to the
 * configured owner username (else null). Logout keeps it: it marks the browser, not a session.
 */
export function readKnownDevice(store: CookieReader): DeviceToken | null {
  const env = getEnv();
  const d = verifyDeviceToken(store.get(DEVICE_COOKIE)?.value, env.SESSION_SECRET);
  return d && constantTimeEqual(d.u, env.OWNER_USERNAME) ? d : null;
}

/** Cookies that clear the session (logout). */
export function clearedOwnerCookies(): [CookieSpec, CookieSpec] {
  const secure = secureCookies();
  return [
    {
      name: SESSION_COOKIE,
      value: "",
      options: { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: 0 },
    },
    {
      name: CSRF_COOKIE,
      value: "",
      options: { httpOnly: false, sameSite: "strict", secure, path: "/", maxAge: 0 },
    },
  ];
}

/** Anything with `get(name)` → `{ value }` (Next `cookies()`, `request.cookies`). */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * Verified, ACTIVE (not logged out) session from a cookie store, or null. Also checks the
 * username still matches.
 */
export function getOwnerSession(store: CookieReader): OwnerSession | null {
  const env = getEnv();
  const session = verifySession(store.get(SESSION_COOKIE)?.value, env.SESSION_SECRET);
  if (!session || !constantTimeEqual(session.u, env.OWNER_USERNAME)) return null;
  if (!isSessionActive(session.sid)) return null;
  return session;
}

/** Logout: revoke the session in the cookie (if any) server-side. */
export function endOwnerSession(store: CookieReader): void {
  const session = verifySession(store.get(SESSION_COOKIE)?.value, getEnv().SESSION_SECRET);
  if (session) revokeSession(session.sid);
}

/** Server components / server actions: returns the session or redirects to /owner/login. */
export async function requireOwner(): Promise<OwnerSession> {
  const session = getOwnerSession(await cookies());
  if (!session) redirect(OWNER_LOGIN_PATH);
  return session;
}

/**
 * Route handlers: `const auth = requireOwnerApi(request); if (auth instanceof Response) return auth;`
 * (The proxy already enforced the CSRF token for non-GET owner API calls.)
 */
export function requireOwnerApi(request: { cookies: CookieReader }): OwnerSession | Response {
  const session = getOwnerSession(request.cookies);
  if (session) return session;
  return Response.json(
    { error: "unauthorized", message: "Please sign in." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}
