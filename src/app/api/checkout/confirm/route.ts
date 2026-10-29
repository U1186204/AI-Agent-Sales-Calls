/**
 * POST /api/checkout/confirm  (CheckoutInput → CheckoutResult)
 *
 * The domain re-checks everything and, in ONE transaction, claims stock (guarded decrement)
 * or the slot run (guarded `status = open` flip of every slot), writes the encrypted
 * customer, Order/Booking + Payment (via the configured PaymentProvider — today
 * Payment{none,not_required}), and completes the draft.
 * Idempotent on draftId: a replay (double submit, retry, or the loser of a race) returns the
 * existing reference with `replayed: true` and sends NO notifications.
 *
 * On a fresh success the customer email + business email + business SMS go out (awaited,
 * mocked to .data/outbox without provider keys). A notification failure never fails the
 * confirm; the response carries only per-channel statuses (no recipients).
 *
 * 200 CheckoutResult{ok:true} · 400 malformed body · 404 draft_not_found ·
 * 402 payment_failed (provider declined; today's "none" provider never does) ·
 * 409 out_of_stock / slot_unavailable / already_completed · 410 draft_expired ·
 * 422 validation / outside_service_area · 429 rate_limited · 500 internal.
 */
import type { NextRequest } from "next/server";
import { CheckoutInput } from "@/contracts";
import { confirmCheckout, type CheckoutRequest } from "@/domain";
import { apiContext } from "@/guard/api";
import { dispatchCheckoutNotifications } from "@/notify";
import { readCheckoutBody, toNotificationPayload } from "../../_lib/checkout";
import { checkoutFailure, json, safeErr } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChannelStatus = "sent" | "mocked" | "failed" | "skipped";

export async function POST(request: NextRequest): Promise<Response> {
  const ctx = apiContext(request);
  try {
    const parsed = await readCheckoutBody(request, ctx, "confirm");
    if (parsed instanceof Response) return parsed;
    const r = await confirmCheckout(parsed.body as CheckoutRequest);
    if (!r.ok) {
      ctx.log.info("checkout_confirm_rejected", {
        code: r.code,
        fields: r.fieldErrors ? Object.keys(r.fieldErrors) : undefined,
      });
      return checkoutFailure(r, ctx.reqId);
    }

    let notifications:
      Record<"customerEmail" | "businessEmail" | "businessSms", ChannelStatus> | undefined;
    if (!r.replayed && r.notification) {
      try {
        // Validated by the domain already; parsed again only to get the normalized form.
        const input = CheckoutInput.parse(parsed.body);
        const res = await dispatchCheckoutNotifications(
          toNotificationPayload(r.notification, input.customer),
        );
        notifications = {
          customerEmail: res.customerEmail.status,
          businessEmail: res.businessEmail.status,
          businessSms: res.businessSms.status,
        };
      } catch (err) {
        // The order/booking is committed; a notification problem must not fail the confirm.
        ctx.log.error("checkout_notify_failed", { reference: r.reference, error: safeErr(err) });
        notifications = { customerEmail: "failed", businessEmail: "failed", businessSms: "failed" };
      }
    }

    ctx.log.info("checkout_confirmed", {
      reference: r.reference,
      kind: r.kind,
      totalCents: r.totalCents,
      replayed: r.replayed,
      notifications,
    });
    return json(
      {
        ok: true,
        kind: r.kind,
        reference: r.reference,
        status: r.status,
        totalCents: r.totalCents,
        replayed: r.replayed,
        ...(notifications ? { notifications } : {}),
      },
      200,
      ctx.reqId,
    );
  } catch (err) {
    ctx.log.error("checkout_confirm_failed", { error: safeErr(err) });
    return checkoutFailure(
      {
        ok: false,
        code: "internal",
        message:
          "Something went wrong confirming your order. Nothing was charged; please try again.",
      },
      ctx.reqId,
    );
  }
}
