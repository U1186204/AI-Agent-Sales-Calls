/**
 * POST /api/owner/login  { username, password }
 * 200 { ok: true, csrfToken } + cookies `oasis_owner` (HttpOnly), `oasis_csrf` and the 30-day
 * known-device cookie `oasis_device` (HttpOnly, SameSite=Strict, signed, R2-3).
 * 400 malformed body · 401 generic "Invalid username or password." · 413 body too large ·
 * 429 throttled.
 *
 * Throttling (SEC-2): 5 attempts / 15 min per client address, PLUS the IP-independent login
 * guard (per-username exponential backoff capped at 15 min, and a global failure cap). A
 * browser with a valid known-device cookie bypasses the IP-independent parts and is throttled
 * on its own device key instead of the IP, so neither rotating addresses nor sharing the
 * owner's address can lock the owner out (see guard/rate-limit `LoginGuard`).
 * CSRF: the proxy enforces the same-origin check (no double-submit token before login).
 */
import { NextResponse, type NextRequest } from "next/server";
import { OwnerLogin } from "@/contracts";
import {
  constantTimeEqual,
  createKnownDeviceCookie,
  createOwnerSessionCookies,
  readKnownDevice,
  verifyOwnerCredentials,
} from "@/auth/session";
import { apiContext, tooManyRequests } from "@/guard/api";
import { checkLoginRateLimit, loginGuard, resetLoginRateLimit } from "@/guard/rate-limit";
import { readBody, tooLarge } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC = "Invalid username or password.";
const THROTTLED = "Too many sign-in attempts. Please wait a few minutes and try again.";

export async function POST(request: NextRequest) {
  const { reqId, ip, log } = apiContext(request);
  const headers = { "x-request-id": reqId, "cache-control": "no-store" };

  // R2-3: a signed known-device cookie (not the IP address) marks the owner's browser.
  const device = readKnownDevice(request.cookies);
  const throttleKey = device ? `device:${device.id}` : ip;
  const throttle = checkLoginRateLimit(throttleKey);
  if (!throttle.ok) {
    log.warn("owner_login_throttled", {
      scope: device ? "device" : "ip",
      retryAfterSec: throttle.retryAfterSec,
    });
    return tooManyRequests(throttle.retryAfterSec, reqId, THROTTLED);
  }

  const body = await readBody(request, 4 * 1024);
  if (!body.ok && body.tooLarge) return tooLarge(reqId);
  const parsed = OwnerLogin.safeParse(body.ok ? body.value : undefined);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", message: GENERIC }, { status: 400, headers });
  }

  const guard = loginGuard();
  const knownDevice = device !== null && constantTimeEqual(device.u, parsed.data.username.trim());
  const gate = guard.check(parsed.data.username, knownDevice);
  if (!gate.ok) {
    log.warn("owner_login_throttled", { scope: "account", retryAfterSec: gate.retryAfterSec });
    return tooManyRequests(gate.retryAfterSec, reqId, THROTTLED);
  }

  const ok = await verifyOwnerCredentials(parsed.data.username, parsed.data.password);
  if (!ok) {
    guard.recordFailure(parsed.data.username);
    log.warn("owner_login_failed");
    return NextResponse.json(
      { error: "invalid_credentials", message: GENERIC },
      { status: 401, headers },
    );
  }

  resetLoginRateLimit(throttleKey);
  guard.recordSuccess(parsed.data.username);
  const username = parsed.data.username.trim();
  const { cookies, csrfToken } = createOwnerSessionCookies(username);
  const res = NextResponse.json({ ok: true, csrfToken }, { status: 200, headers });
  for (const c of [...cookies, createKnownDeviceCookie(username)]) {
    res.cookies.set(c.name, c.value, c.options);
  }
  log.info("owner_login_ok", { knownDevice });
  return res;
}
