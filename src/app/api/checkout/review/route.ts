/**
 * POST /api/checkout/review  (CheckoutInput → CheckoutReview)
 *
 * Re-validates the form (CustomerForm), draft state, stock or slot run, service area and
 * re-prices with shipping to the entered ZIP. Nothing is written.
 *
 * 200 CheckoutReview · 4xx/5xx CheckoutResult{ok:false, code, message, fieldErrors?}:
 * 400 malformed body · 404 draft_not_found · 409 already_completed / out_of_stock /
 * slot_unavailable · 410 draft_expired · 422 validation / outside_service_area ·
 * 429 rate_limited · 500 internal.
 */
import type { NextRequest } from "next/server";
import { reviewCheckout, type CheckoutRequest } from "@/domain";
import { apiContext } from "@/guard/api";
import { readCheckoutBody } from "../../_lib/checkout";
import { checkoutFailure, json, safeErr } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const ctx = apiContext(request);
  try {
    const parsed = await readCheckoutBody(request, ctx, "review");
    if (parsed instanceof Response) return parsed;
    const r = await reviewCheckout(parsed.body as CheckoutRequest);
    if (!r.ok) {
      ctx.log.info("checkout_review_rejected", {
        code: r.code,
        fields: r.fieldErrors ? Object.keys(r.fieldErrors) : undefined,
      });
      return checkoutFailure(r, ctx.reqId);
    }
    ctx.log.info("checkout_reviewed", {
      draftId: r.review.draftId,
      businessId: r.review.businessId,
      kind: r.review.kind,
      totalCents: r.review.quote.totalCents,
    });
    return json(r.review, 200, ctx.reqId);
  } catch (err) {
    ctx.log.error("checkout_review_failed", { error: safeErr(err) });
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
