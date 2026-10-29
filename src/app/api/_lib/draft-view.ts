/**
 * Domain DraftView → public CheckoutDraftView (PII-free), shared by
 * GET /api/checkout/draft/:id and PATCH /api/checkout/draft/:id/selection.
 */
import type { CheckoutDraftView } from "@/contracts";
import { BOOKING_HORIZON_DAYS } from "@/config/constants";
import { listDraftSlots, type DraftView } from "@/domain";
import { addDays, localDateString } from "@/lib/tz";

export async function toCheckoutDraftView(d: DraftView, now: Date): Promise<CheckoutDraftView> {
  const view: CheckoutDraftView = {
    draftId: d.draftId,
    kind: d.kind,
    businessId: d.businessId,
    businessName: d.businessName,
    summary: d.summary,
    status: d.status,
    ...(d.reference ? { resultRef: d.reference } : {}),
    quote: d.quote,
    expiresAt: d.expiresAt,
  };
  if (d.items) {
    view.items = d.items.map((i) => ({
      sku: i.sku,
      name: i.name,
      qty: i.qty,
      lineCents: i.lineCents,
    }));
  }
  if (d.service) {
    view.service = {
      code: d.service.code,
      name: d.service.name,
      tierName: d.service.tierName,
      durationMin: d.service.durationMin,
      timezone: d.timezone,
      slot: d.service.slot,
      config: d.service.config,
      options: d.service.options,
    };
    if (d.status === "open") {
      const slots = await listDraftSlots(d.draftId, undefined, now, d.conversationId);
      if (slots.ok) {
        const today = localDateString(now, slots.timezone);
        view.availability = {
          timezone: slots.timezone,
          fromDate: today,
          toDate: addDays(today, BOOKING_HORIZON_DAYS - 1),
          dates: slots.availableDates,
        };
      }
    }
  }
  return view;
}
