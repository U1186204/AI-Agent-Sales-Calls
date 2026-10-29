/**
 * POST /api/owner/logout → 200 { ok: true }, revokes the session server-side (SEC-4: the old
 * cookie no longer works, even if copied) and clears `oasis_owner` + `oasis_csrf`.
 * The proxy requires a same-origin request with the session-bound `x-csrf-token` header.
 */
import { NextResponse, type NextRequest } from "next/server";
import { clearedOwnerCookies, endOwnerSession } from "@/auth/session";
import { apiContext } from "@/guard/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { reqId, log } = apiContext(request);
  endOwnerSession(request.cookies);
  const res = NextResponse.json(
    { ok: true },
    { status: 200, headers: { "x-request-id": reqId, "cache-control": "no-store" } },
  );
  for (const c of clearedOwnerCookies()) res.cookies.set(c.name, c.value, c.options);
  log.info("owner_logout");
  return res;
}
