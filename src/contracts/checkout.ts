import { z } from "zod";
import { Cents, CheckoutKind, Code, Id, IsoDateTime, Reference, Sku } from "./common";
import { CustomerForm, MaskedCustomer } from "./customer";

// ---------------------------------------------------------------------------
// Selections (what is being bought/booked — never PII)
// ---------------------------------------------------------------------------

export const ProductLineInput = z.object({
  sku: Sku,
  qty: z.number().int().min(1).max(999),
});
export type ProductLineInput = z.infer<typeof ProductLineInput>;

export const ProductSelection = z.object({
  lines: z.array(ProductLineInput).min(1).max(50),
});
export type ProductSelection = z.infer<typeof ProductSelection>;

export const QtyCode = z.object({
  code: Code,
  qty: z.number().int().min(1).max(10_000).default(1),
});
export type QtyCode = z.infer<typeof QtyCode>;

export const ServiceFrequencyCode = z.enum([
  "one_time",
  "weekly",
  "biweekly",
  "monthly",
  "seasonal_prepay",
]);
export type ServiceFrequencyCode = z.infer<typeof ServiceFrequencyCode>;

/** A priced service configuration (keys into src/config/pricing.ts SERVICE_CATALOG). */
export const ServiceConfig = z.object({
  serviceCode: Code,
  tierCode: Code,
  /** Count for the tier's `extraUnit` (e.g. additional acres), if the tier has one. */
  extraUnits: z.number().int().min(0).max(100).default(0),
  addOns: z.array(QtyCode).max(20).default([]),
  surcharges: z.array(QtyCode).max(20).default([]),
  frequency: ServiceFrequencyCode.default("one_time"),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

export const ServiceSelection = ServiceConfig.extend({
  /** Anchor slot from check_availability. */
  slotId: Id,
});
export type ServiceSelection = z.infer<typeof ServiceSelection>;

// ---------------------------------------------------------------------------
// Quotes (computed only by the domain pricing engine)
// ---------------------------------------------------------------------------

export const QuoteLineKind = z.enum([
  "goods",
  "service",
  "extra_unit",
  "addon",
  "surcharge",
  "discount",
  "shipping",
  "handling",
]);

export const QuoteLine = z.object({
  kind: QuoteLineKind,
  /** SKU, tier/add-on/surcharge code, or a synthetic code such as "shipping". */
  code: z.string(),
  label: z.string(),
  qty: z.number().int().min(0),
  unitCents: z.number().int(),
  /** Signed: discounts are negative. */
  amountCents: z.number().int(),
  taxable: z.boolean(),
  minutes: z.number().int().min(0).optional(),
  note: z.string().optional(),
});
export type QuoteLine = z.infer<typeof QuoteLine>;

export const Quote = z.object({
  currency: z.literal("USD"),
  lines: z.array(QuoteLine),
  /** Sum of goods/service/add-on/surcharge lines before discounts. */
  subtotalCents: Cents,
  discountCents: Cents,
  shippingCents: Cents,
  taxableCents: Cents,
  taxRateBps: z.number().int().min(0),
  taxCents: Cents,
  totalCents: Cents,
  /** Services only. */
  durationMin: z.number().int().min(0).optional(),
  /** Products only, when a ZIP was given. */
  shipZone: z.number().int().min(2).max(8).optional(),
  shipZip: z.string().optional(),
  /** Human notes, e.g. "Free shipping applied", "Price confirmed on site". */
  notes: z.array(z.string()).default([]),
  taxDisclaimer: z.string(),
});
export type Quote = z.infer<typeof Quote>;

// ---------------------------------------------------------------------------
// Checkout API bodies (/api/checkout/review, /api/checkout/confirm)
// ---------------------------------------------------------------------------

/**
 * Every checkout body carries the `conversationId` of the chat that created the draft: a draft
 * is bound to its conversation (a leaked draft id alone cannot review/confirm it, and a replay
 * only returns the reference to that same conversation).
 */
export const ProductCheckoutInput = z.object({
  kind: z.literal("product"),
  draftId: Id,
  conversationId: Id,
  customer: CustomerForm,
});
export type ProductCheckoutInput = z.infer<typeof ProductCheckoutInput>;

export const ServiceCheckoutInput = z.object({
  kind: z.literal("service"),
  draftId: Id,
  conversationId: Id,
  customer: CustomerForm,
  /** Anchor slot picked in the form (from listDraftSlots); defaults to the draft's slot. */
  slotId: Id.optional(),
});
export type ServiceCheckoutInput = z.infer<typeof ServiceCheckoutInput>;

export const CheckoutInput = z.discriminatedUnion("kind", [
  ProductCheckoutInput,
  ServiceCheckoutInput,
]);
export type CheckoutInput = z.infer<typeof CheckoutInput>;

export const SlotSummary = z.object({
  slotId: Id,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  /** Local date/time strings in the business timezone, for display. */
  localDate: z.string(),
  localTime: z.string(),
  timezone: z.string(),
  contractor: z.string(),
});
export type SlotSummary = z.infer<typeof SlotSummary>;

/** Server response to /api/checkout/review: everything the confirm screen shows. */
export const CheckoutReview = z.object({
  draftId: Id,
  kind: CheckoutKind,
  businessId: z.string(),
  businessName: z.string(),
  customer: MaskedCustomer,
  quote: Quote,
  /** Product checkout: item summary lines. */
  items: z
    .array(z.object({ sku: z.string(), name: z.string(), qty: z.number().int(), lineCents: Cents }))
    .optional(),
  /** Service checkout. */
  service: z
    .object({ code: z.string(), name: z.string(), tierName: z.string(), slot: SlotSummary })
    .optional(),
  expiresAt: IsoDateTime,
  /** Warnings that do not block confirm (e.g. "Price confirmed on site"). */
  warnings: z.array(z.string()).default([]),
});
export type CheckoutReview = z.infer<typeof CheckoutReview>;

export const CheckoutErrorCode = z.enum([
  "validation",
  "draft_not_found",
  "draft_expired",
  "already_completed",
  "out_of_stock",
  "slot_unavailable",
  "outside_service_area",
  /** The payment provider declined/failed; nothing was claimed or recorded. */
  "payment_failed",
  "rate_limited",
  "internal",
]);
export type CheckoutErrorCode = z.infer<typeof CheckoutErrorCode>;

export const CheckoutResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    kind: CheckoutKind,
    reference: Reference,
    status: z.string(),
    totalCents: Cents,
    /** True when this draft had already been confirmed (idempotent replay). */
    replayed: z.boolean().default(false),
  }),
  z.object({
    ok: z.literal(false),
    code: CheckoutErrorCode,
    message: z.string(),
    /** Field errors for `validation` (field name → messages). */
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
]);
export type CheckoutResult = z.infer<typeof CheckoutResult>;
