/**
 * PATCH /api/checkout/draft/:draftId/selection  (DraftSelectionUpdate → DraftSelectionUpdated)
 *
 * The booking form's "Service details": the customer changes tier, add-ons, conditions or
 * frequency of an open booking draft. The body carries codes and quantities only; the server
 * re-prices with the pricing engine, clears a chosen time that no longer fits the new job
 * length, and stores both. Review and confirm keep re-checking from the stored draft.
 *
 * CSRF + the per-IP API limit run in src/proxy.ts (every non-GET /api request).
 * SEC-3: only the conversation that created the draft can change it; any other gets the same
 * 404 as an unknown draft.
 *
 * 200 DraftSelectionUpdated · 4xx/5xx CheckoutResult{ok:false, code, message, fieldErrors?}:
 * 400 malformed body/id · 404 draft_not_found · 409 already_completed · 410 draft_expired ·
 * 413 too large · 422 validation (unknown codes, conflicts, on-site estimate) ·
 * 429 rate_limited · 500 internal.
 */
import type { NextRequest } from "next/server";
import { DraftSelectionUpdate, Id, type DraftSelectionUpdated } from "@/contracts";
import { updateDraftServiceConfig } from "@/domain";
import { apiContext } from "@/guard/api";
import { checkDraftEditRateLimit } from "@/guard/rate-limit";
import { toCheckoutDraftView } from "../../../../_lib/draft-view";
import { checkoutFailure, json, readBody, safeErr } from "../../../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 400 malformed / 413 too large, in the CheckoutResult shape the form understands. */
const malformed = (reqId: string, status: 400 | 413 = 400) =>
  json(
    {
      ok: false,
      code: "validation",
      message:
        status === 413
          ? "This request is too large."
          : "The request was malformed. Please reload and try again.",
      fieldErrors: { form: [status === 413 ? "Request too large" : "Malformed request"] },
    },
    status,
    reqId,
  );

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const ctx = apiContext(request);
  try {
    const rl = checkDraftEditRateLimit(ctx.ip);
    if (!rl.ok) {
      ctx.log.warn("draft_edit_rate_limited", { retryAfterSec: rl.retryAfterSec });
      return checkoutFailure(
        { ok: false, code: "rate_limited", message: "Too many changes. Wait a moment." },
        ctx.reqId,
        { "retry-after": String(rl.retryAfterSec) },
      );
    }
    const { draftId } = await params;
    if (!Id.safeParse(draftId).success) return malformed(ctx.reqId);
    const read = await readBody(request);
    if (!read.ok) return malformed(ctx.reqId, read.tooLarge ? 413 : 400);
    const parsed = DraftSelectionUpdate.safeParse(read.value);
    if (!parsed.success) return malformed(ctx.reqId);

    const now = new Date();
    const r = await updateDraftServiceConfig(
      parsed.data.conversationId,
      draftId,
      parsed.data.config,
      now,
    );
    if (!r.ok) {
      ctx.log.info("draft_edit_rejected", {
        code: r.code,
        fields: r.fieldErrors ? Object.keys(r.fieldErrors) : undefined,
      });
      return checkoutFailure(r, ctx.reqId);
    }
    ctx.log.info("draft_edited", {
      draftId,
      businessId: r.view.businessId,
      totalCents: r.view.quote.totalCents,
      slotCleared: r.slotCleared,
    });
    const body: DraftSelectionUpdated = {
      draft: await toCheckoutDraftView(r.view, now),
      slotCleared: r.slotCleared,
    };
    return json(body, 200, ctx.reqId);
  } catch (err) {
    ctx.log.error("draft_edit_failed", { error: safeErr(err) });
    return checkoutFailure(
      {
        ok: false,
        code: "internal",
        message: "Something went wrong on our side. Please try again.",
      },
      ctx.reqId,
    );
  }
}
