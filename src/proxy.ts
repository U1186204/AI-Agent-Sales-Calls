/**
 * Request interceptor (Next.js 16 `proxy.ts`, formerly `middleware.ts`; Node.js runtime).
 *
 * For every matched request:
 *  - assigns `x-request-id` (keeps a safe incoming one) on the request and the response;
 *  - `/api/*`: CSRF (same-origin for all non-GET; double-submit token for owner routes) and
 *    the per-IP API rate limit (`guardApi`);
 *  - `/owner/**` pages (except /owner/login): redirect to /owner/login when the signed
 *    session cookie is missing/invalid/expired (pages still call `requireOwner()`);
 *  - pages: per-request nonce Content-Security-Policy (`script-src 'nonce-…' 'strict-dynamic'`).
 *    The CSP is also set on the forwarded request so Next.js stamps the nonce on its scripts;
 *    the root layout opts every page into dynamic rendering (`connection()`) for this.
 * Static security headers (HSTS, nosniff, …) come from next.config.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/config/env";
import { isSessionActive } from "@/auth/session-store";
import { SESSION_COOKIE, csrfTokenMatches, verifySession } from "@/auth/session-token";
import { guardApi } from "@/guard/api";
import { REQUEST_ID_HEADER, acceptRequestId } from "@/guard/request-id";
import { API_CSP, buildCsp, generateNonce } from "@/guard/security-headers";

const OWNER_LOGIN = "/owner/login";

function isOwnerPage(pathname: string): boolean {
  return (
    (pathname === "/owner" || pathname.startsWith("/owner/")) &&
    pathname !== OWNER_LOGIN &&
    !pathname.startsWith(`${OWNER_LOGIN}/`)
  );
}

export function proxy(request: NextRequest) {
  const reqId = acceptRequestId(request.headers.get(REQUEST_ID_HEADER));
  const { pathname } = request.nextUrl;
  const env = getEnv();

  if (pathname.startsWith("/api/")) {
    const blocked = guardApi(request, reqId, {
      // SEC-8: the owner CSRF token must be the one bound to THIS (active) session.
      isCsrfTokenBound: (token) => {
        const s = verifySession(request.cookies.get(SESSION_COOKIE)?.value, env.SESSION_SECRET);
        return Boolean(
          s && isSessionActive(s.sid) && csrfTokenMatches(token, s.sid, env.SESSION_SECRET),
        );
      },
    });
    if (blocked) {
      blocked.headers.set("Content-Security-Policy", API_CSP);
      return blocked;
    }
    const headers = new Headers(request.headers);
    headers.set(REQUEST_ID_HEADER, reqId);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set(REQUEST_ID_HEADER, reqId);
    res.headers.set("Content-Security-Policy", API_CSP);
    return res;
  }

  if (isOwnerPage(pathname)) {
    const session = verifySession(request.cookies.get(SESSION_COOKIE)?.value, env.SESSION_SECRET);
    if (!session || session.u !== env.OWNER_USERNAME || !isSessionActive(session.sid)) {
      const url = request.nextUrl.clone();
      url.pathname = OWNER_LOGIN;
      url.search = "";
      if (pathname !== "/owner") url.searchParams.set("next", pathname);
      const res = NextResponse.redirect(url, 307);
      res.headers.set(REQUEST_ID_HEADER, reqId);
      res.headers.set("cache-control", "no-store");
      return res;
    }
  }

  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    dev: env.NODE_ENV === "development",
    upgradeInsecure: env.NODE_ENV === "production" && env.APP_URL.startsWith("https://"),
  });
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, reqId);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    // Everything except build assets and files with an extension (favicon.ico, images, …).
    "/((?!_next/static|_next/image|.*\\.[A-Za-z0-9]{1,8}$).*)",
  ],
};
