/**
 * GET /api/checkout/draft/:draftId?conversationId=<id> → CheckoutDraftView (PII-free; see
 * src/contracts/checkout-view.ts). The conversation id may also come in the
 * `x-conversation-id` header.
 *
 * SEC-3: a draft is visible only to the conversation that created it; any other (or a
 * missing/wrong conversation id) gets the same 404 as an unknown draft.
 *
 * 200 view (any status: open | completed | expired — the form decides what to show)
 * 400 malformed id · 404 unknown draft · 500 internal. Errors: `{ error: { code, message } }`.
 */
import type { NextRequest } from "next/server";
import { Id } from "@/contracts";
import { getCheckoutDraftForConversation } from "@/domain";
import { apiContext } from "@/guard/api";
import { toCheckoutDraftView } from "../../../_lib/draft-view";
import { apiError, conversationIdParam, json, safeErr } from "../../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const { reqId, log } = apiContext(request);
  try {
    const { draftId } = await params;
    if (!Id.safeParse(draftId).success) {
      return apiError(400, "invalid_request", "Invalid checkout id.", reqId);
    }
    const conversationId = conversationIdParam(request);
    const now = new Date();
    const d = conversationId
      ? await getCheckoutDraftForConversation(conversationId, draftId, now)
      : null;
    if (!d) {
      return apiError(404, "draft_not_found", "This checkout was not found.", reqId);
    }
    const view = await toCheckoutDraftView(d, now);
    return json(view, 200, reqId);
  } catch (err) {
    log.error("checkout_draft_failed", { error: safeErr(err) });
    return apiError(500, "internal", "Something went wrong on our side. Please try again.", reqId);
  }
}
