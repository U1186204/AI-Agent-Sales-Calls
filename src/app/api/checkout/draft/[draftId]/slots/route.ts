/**
 * GET /api/checkout/draft/:draftId/slots?date=YYYY-MM-DD&conversationId=<id> → DraftSlotsView
 * {date, timezone, slots}. Only the conversation that created the draft (SEC-3); others → 404.
 *
 * Real open start times (business timezone) long enough for this draft's job.
 * 400 bad id/date or product draft · 404 unknown · 409 already completed · 410 expired.
 */
import type { NextRequest } from "next/server";
import { Id, IsoDate, type DraftSlotsView } from "@/contracts";
import { listDraftSlots } from "@/domain";
import { apiContext } from "@/guard/api";
import { apiError, conversationIdParam, json, safeErr } from "../../../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS = {
  draft_not_found: 404,
  draft_expired: 410,
  already_completed: 409,
  not_service: 400,
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const { reqId, log } = apiContext(request);
  try {
    const { draftId } = await params;
    const date = IsoDate.safeParse(request.nextUrl.searchParams.get("date") ?? "");
    if (!Id.safeParse(draftId).success || !date.success) {
      return apiError(400, "invalid_request", "Use ?date=YYYY-MM-DD.", reqId);
    }
    const r = await listDraftSlots(
      draftId,
      date.data,
      new Date(),
      conversationIdParam(request) ?? "",
    );
    if (!r.ok) return apiError(STATUS[r.code], r.code, r.message, reqId);
    const body: DraftSlotsView = { date: date.data, timezone: r.timezone, slots: r.slots };
    return json(body, 200, reqId);
  } catch (err) {
    log.error("checkout_slots_failed", { error: safeErr(err) });
    return apiError(500, "internal", "Something went wrong on our side. Please try again.", reqId);
  }
}
