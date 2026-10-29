/**
 * POST /api/status  (StatusLookup {reference, email} → StatusResponse)
 *
 * The /status page has no business picker, so the reference is looked up across every
 * business. Every lookup runs the same work for all businesses (no early exit), and a wrong
 * reference, wrong email, or both get the SAME generic not-found body with the same status
 * code — the response never reveals which half was wrong.
 *
 * Rate limited per IP (RATE_LIMIT_STATUS_PER_10MIN, default 10 / 10 min) against reference
 * enumeration; found and not-found lookups both count.
 *
 * 200 found | generic not-found · 400 body is not a reference + email · 429 · 500.
 * Never logs the email or the reference.
 */
import type { NextRequest } from "next/server";
import { StatusLookup, type StatusResponse } from "@/contracts";
import { BUSINESSES } from "@/config/businesses";
import { lookupStatus, type StatusResult } from "@/domain";
import { apiContext, tooManyRequests } from "@/guard/api";
import { checkStatusRateLimit } from "@/guard/rate-limit";
import { apiError, json, readBody, safeErr, tooLarge } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND: StatusResponse = {
  found: false,
  message:
    "We could not find an order or booking with that reference and email. Check both and try again.",
};

export async function POST(request: NextRequest): Promise<Response> {
  const { reqId, ip, log } = apiContext(request);
  try {
    const rl = checkStatusRateLimit(ip);
    if (!rl.ok) {
      log.warn("status_rate_limited", { retryAfterSec: rl.retryAfterSec });
      return tooManyRequests(
        rl.retryAfterSec,
        reqId,
        "Too many lookups. Please wait a few minutes and try again.",
      );
    }
    const read = await readBody(request, 4 * 1024);
    if (!read.ok && read.tooLarge) return tooLarge(reqId);
    const parsed = StatusLookup.safeParse(read.ok ? read.value : undefined);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        "Enter a reference like OAS-ABCD-2345 and the email used at checkout.",
        reqId,
      );
    }

    // Same work for every business, whatever matches (constant shape and timing).
    const results = await Promise.all(BUSINESSES.map((b) => lookupStatus(b.id, parsed.data)));
    const hit = results.find((r): r is Extract<StatusResult, { found: true }> => r.found);
    log.info("status_lookup", { found: Boolean(hit) });
    if (!hit) return json(NOT_FOUND, 200, reqId);

    // Contract fields only (the domain also returns the first name and totals for the agent).
    const body: StatusResponse = {
      found: true,
      kind: hit.kind,
      reference: hit.reference,
      status: hit.status,
      totalCents: hit.totalCents,
      createdAt: hit.createdAt,
      ...(hit.appointment ? { appointment: hit.appointment } : {}),
      ...(hit.serviceName ? { serviceName: hit.serviceName } : {}),
      ...(hit.itemsLabel ? { itemsLabel: hit.itemsLabel } : {}),
      summary: hit.summary,
    };
    return json(body, 200, reqId);
  } catch (err) {
    log.error("status_lookup_failed", { error: safeErr(err) });
    return apiError(500, "internal", "Something went wrong on our side. Please try again.", reqId);
  }
}
