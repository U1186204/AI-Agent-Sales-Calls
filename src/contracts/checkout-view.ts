/**
 * Read-only checkout views for the inline form (PII-free).
 *
 *   GET  /api/checkout/draft/:draftId                 -> CheckoutDraftView (404 unknown)
 *   GET  /api/checkout/draft/:draftId/slots?date=D    -> DraftSlotsView
 *   PATCH /api/checkout/draft/:draftId/selection body DraftSelectionUpdate
 *                                                     -> 200 DraftSelectionUpdated | 4xx CheckoutResult{ok:false}
 *   POST /api/checkout/review   body CheckoutInput    -> 200 CheckoutReview | 4xx CheckoutResult{ok:false}
 *   POST /api/checkout/confirm  body CheckoutInput    -> CheckoutResult (200 ok:true | 4xx ok:false)
 *
 * Field-error keys (CheckoutResult.fieldErrors) are canonical: bare CustomerForm field
 * names (`email`, `zip`, …) plus `slotId` for the appointment time and `form` for
 * whole-body problems — never `customer.email`.
 */
import { z } from "zod";
import { Cents, CheckoutKind, Id, IsoDate, IsoDateTime } from "./common";
import { ServiceOptions } from "./cards";
import { Quote, ServiceConfig, SlotSummary } from "./checkout";

export const DraftStatus = z.enum(["open", "completed", "expired"]);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const CheckoutDraftView = z.object({
  draftId: Id,
  kind: CheckoutKind,
  businessId: z.string(),
  businessName: z.string(),
  /** Same PII-free summary as the chat `form` block. */
  summary: z.string(),
  status: DraftStatus,
  /** Order/booking reference once completed. */
  resultRef: z.string().optional(),
  quote: Quote,
  items: z
    .array(z.object({ sku: z.string(), name: z.string(), qty: z.number().int(), lineCents: Cents }))
    .optional(),
  service: z
    .object({
      code: z.string(),
      name: z.string(),
      tierName: z.string(),
      durationMin: z.number().int().min(0),
      timezone: z.string(),
      /** The slot chosen in chat (pre-selected in the form), or null. */
      slot: SlotSummary.nullable(),
      /** The configuration being booked (codes), editable in the form's "Service details". */
      config: ServiceConfig,
      /** Every option of this service, labelled for customers (from config). */
      options: ServiceOptions,
    })
    .optional(),
  /** Services: local dates (business timezone) with at least one start long enough for this job. */
  availability: z
    .object({
      timezone: z.string(),
      fromDate: IsoDate,
      toDate: IsoDate,
      dates: z.array(IsoDate),
    })
    .optional(),
  expiresAt: IsoDateTime,
});
export type CheckoutDraftView = z.infer<typeof CheckoutDraftView>;

export const DraftSlotsView = z.object({
  date: IsoDate,
  timezone: z.string(),
  slots: z.array(SlotSummary),
});
export type DraftSlotsView = z.infer<typeof DraftSlotsView>;

/**
 * Change the service configuration of an open booking draft. Codes only: the server re-prices
 * with the pricing engine, re-checks the chosen time against the new job length and stores
 * both. Review and confirm keep re-checking everything from the stored draft.
 */
export const DraftSelectionUpdate = z.object({
  conversationId: Id,
  config: ServiceConfig,
});
export type DraftSelectionUpdate = z.infer<typeof DraftSelectionUpdate>;

export const DraftSelectionUpdated = z.object({
  draft: CheckoutDraftView,
  /** True when the previously chosen time no longer fits the new job length. */
  slotCleared: z.boolean(),
});
export type DraftSelectionUpdated = z.infer<typeof DraftSelectionUpdated>;
