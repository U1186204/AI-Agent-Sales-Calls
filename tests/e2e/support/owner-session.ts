/**
 * Real owner sessions for e2e. The server keeps an allowlist of live session ids (logout
 * revokes them), so a cookie signed locally is no longer accepted: every helper here signs in
 * through POST /api/owner/login, once per test worker, and reuses that session.
 *
 * The e2e server runs with the documented demo credentials unless overridden with
 * E2E_OWNER_USERNAME / E2E_OWNER_PASSWORD.
 */
import { request as playwrightRequest, type BrowserContext } from "@playwright/test";
import { SESSION_COOKIE } from "../../../src/auth/session-token";
import { E2E_BASE_URL } from "./e2e-env";

export const OWNER_USERNAME = process.env.E2E_OWNER_USERNAME ?? "owner";
export const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? "oasis-demo-2026";

interface OwnerCookies {
  session: string;
  csrf: string;
}

let cached: Promise<OwnerCookies> | null = null;

async function login(): Promise<OwnerCookies> {
  const ctx = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
  try {
    const res = await ctx.post("/api/owner/login", {
      headers: { origin: E2E_BASE_URL },
      data: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
    });
    if (res.status() !== 200) {
      throw new Error(`owner login failed: ${res.status()} ${await res.text()}`);
    }
    const cookies = (await ctx.storageState()).cookies;
    const session = cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    const csrf = cookies.find((c) => c.name === "oasis_csrf")?.value ?? "";
    if (!session) throw new Error("owner login set no session cookie");
    return { session, csrf };
  } finally {
    await ctx.dispose();
  }
}

/** One real session per worker (the login endpoint is throttled). */
export function ownerCookies(): Promise<OwnerCookies> {
  cached ??= login().catch((e: unknown) => {
    cached = null;
    throw e;
  });
  return cached;
}

/** Put a live owner session (and its CSRF cookie) into a browser context. */
export async function signInAsOwner(context: BrowserContext, baseURL: string) {
  const { session, csrf } = await ownerCookies();
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: session,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    { name: "oasis_csrf", value: csrf, domain: url.hostname, path: "/", sameSite: "Strict" },
  ]);
  return { csrf };
}

/** `Cookie` header with a live owner session (for API requests in full-stack specs). */
export async function ownerCookieHeader(): Promise<string> {
  const { session } = await ownerCookies();
  return `${SESSION_COOKIE}=${session}`;
}
