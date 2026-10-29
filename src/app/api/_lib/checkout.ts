/**
 * Checkout route plumbing shared by /api/checkout/review and /api/checkout/confirm:
 * per-IP limit, body envelope check (400) and the domain → notify payload mapping.
 */
import { z } from "zod";
import { CheckoutKind, Id, type CustomerFormData } from "@/contracts";
import type { CheckoutNotification } from "@/domain";
import type { ApiContext } from "@/guard/api";
import { checkCheckoutRateLimit } from "@/guard/rate-limit";
import type { CheckoutNotificationPayload } from "@/notify";
import { json, readBody } from "./http";

/** Just enough shape to route the request; the domain re-validates everything (422). */
const Envelope = z.object({
  kind: CheckoutKind,
  draftId: Id,
  /** The conversation that created the draft (SEC-3). */
  conversationId: Id,
  customer: z.unknown(),
});

/**
 * Rate limit + parse. Returns the raw body for the domain, or a Response to send:
 * 429 over the per-IP checkout limit, 413 over the body cap, 400 when the body is not JSON or
 * lacks kind/draftId/conversationId.
 */
export async function readCheckoutBody(
  request: Request,
  ctx: ApiContext,
  route: "review" | "confirm",
): Promise<{ body: unknown } | Response> {
  const rl = checkCheckoutRateLimit(ctx.ip);
  if (!rl.ok) {
    ctx.log.warn("checkout_rate_limited", { route, retryAfterSec: rl.retryAfterSec });
    // 429 + Retry-After in the CheckoutResult shape the form understands.
    return json(
      {
        ok: false,
        code: "rate_limited",
        message: "Too many attempts. Wait a moment, then try again.",
      },
      429,
      ctx.reqId,
      { "retry-after": String(rl.retryAfterSec) },
    );
  }
  const read = await readBody(request);
  if (!read.ok && read.tooLarge) {
    return json(
      {
        ok: false,
        code: "validation",
        message: "This request is too large.",
        fieldErrors: { form: ["Request too large"] },
      },
      413,
      ctx.reqId,
    );
  }
  const body = read.ok ? read.value : undefined;
  if (!Envelope.safeParse(body).success) {
    return json(
      {
        ok: false,
        code: "validation",
        message: "The checkout request was malformed. Please reload and try again.",
        fieldErrors: { form: ["Malformed request"] },
      },
      400,
      ctx.reqId,
    );
  }
  return { body };
}

function addressLabel(c: CustomerFormData): string {
  return [c.address1, c.address2, c.city, `${c.state} ${c.zip}`].filter(Boolean).join(", ");
}

/**
 * Domain confirm payload + the submitted (already validated) form → notify payload.
 * The form supplies what the domain does not hand out (last name, address, instructions).
 */
export function toNotificationPayload(
  n: CheckoutNotification,
  form: CustomerFormData,
): CheckoutNotificationPayload {
  const lines = n.quote.lines
    .filter((l) => l.kind !== "shipping" && l.kind !== "handling")
    .map((l) => ({
      label: (l.kind === "goods" ? `${l.label} (${l.code})` : l.label).slice(0, 200),
      ...(l.qty >= 1 ? { qty: l.qty } : {}),
      amountCents: l.amountCents,
    }));
  return {
    kind: n.kind === "product" ? "order" : "booking",
    businessId: n.businessId,
    businessName: n.businessName,
    reference: n.reference,
    customer: {
      firstName: n.customer.firstName,
      lastName: form.lastName,
      email: n.customer.email,
      phoneE164: n.customer.phoneE164,
    },
    business: {
      notifyEmail: n.business.notifyEmail,
      notifyPhone: n.business.notifyPhone,
      supportEmail: n.business.supportEmail,
    },
    lines: lines.length
      ? lines
      : [{ label: n.summary.slice(0, 200) || n.reference, amountCents: n.totals.subtotalCents }],
    subtotalCents: n.totals.subtotalCents,
    discountCents: n.totals.discountCents,
    shippingCents: n.totals.shippingCents,
    taxCents: n.totals.taxCents,
    totalCents: n.totals.totalCents,
    ...(n.appointment
      ? {
          appointment: {
            localDateTimeLabel: n.appointment.local,
            durationMin: Math.max(1, n.appointment.durationMin),
          },
        }
      : {}),
    addressLabel: addressLabel(form),
    ...(form.instructions ? { instructions: form.instructions } : {}),
  };
}
