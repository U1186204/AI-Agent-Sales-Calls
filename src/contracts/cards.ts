/**
 * Interactive chat cards (guided flow).
 *
 * Every card is BUILT BY THE SERVER from validated tool output and src/config — never from
 * model text or customer text — so each label, price and option a card shows comes from the
 * same source as the pricing engine. Codes travel only as option values; customers see names.
 *
 * A click on a card is sent back as a `card_action` chat event whose payload is codes,
 * quantities and ids only (never prices, names or labels). The server validates it against
 * the business's own catalog and runs the real tools again (src/agent/card-actions.ts).
 */
import { z } from "zod";
import { Cents, Code, Id, IsoDate, Sku } from "./common";
import { ZipCode } from "./customer";
import {
  ProductLineInput,
  Quote,
  ServiceConfig,
  ServiceFrequencyCode,
  SlotSummary,
} from "./checkout";

/** Max cards attached to one assistant reply. */
export const MAX_CARDS_PER_REPLY = 2;
/** Max products in one product card. */
export const MAX_PRODUCT_CARDS = 6;
/** Max start times in one slot card. */
export const MAX_SLOT_SUGGESTIONS = 6;

// ---------------------------------------------------------------------------
// Service options (one service, labelled for customers)
// ---------------------------------------------------------------------------

export const ServiceTierOption = z.object({
  code: Code,
  name: z.string(),
  description: z.string(),
  /** Starting price of the tier ("$99.00"). */
  priceLabel: z.string(),
  durationLabel: z.string(),
  /** e.g. "2 technicians", only when more than one. */
  crewLabel: z.string().optional(),
  extraUnit: z
    .object({ name: z.string(), priceLabel: z.string(), maxQty: z.number().int().min(1) })
    .optional(),
});
export type ServiceTierOption = z.infer<typeof ServiceTierOption>;

export const ServiceAddOnOption = z.object({
  code: Code,
  name: z.string(),
  description: z.string(),
  /** "+$45.00" or "+$40.00 per 10 panes". */
  priceLabel: z.string(),
  /** "+15 min", absent when it adds no time. */
  timeLabel: z.string().optional(),
  maxQty: z.number().int().min(1),
  unitLabel: z.string().optional(),
  /** Tier codes where this add-on is already included at no charge. */
  includedInTiers: z.array(z.string()).default([]),
});
export type ServiceAddOnOption = z.infer<typeof ServiceAddOnOption>;

/**
 * Add-ons in display order. `exclusive` groups come from config `exclusiveGroup` (pick at most
 * one, e.g. one mount type); the rest are independent extras.
 */
export const ServiceAddOnGroup = z.object({
  key: z.string(),
  label: z.string(),
  exclusive: z.boolean(),
  /** Label of the "no add-on" choice in an exclusive group ("I have my own mount"). */
  noneLabel: z.string().optional(),
  items: z.array(ServiceAddOnOption),
});
export type ServiceAddOnGroup = z.infer<typeof ServiceAddOnGroup>;

export const ServiceSurchargeOption = z.object({
  code: Code,
  name: z.string(),
  condition: z.string(),
  /** "+$100.00", "+50% of the base price" or "+$0.08 per sq ft over 600 per bedroom". */
  priceLabel: z.string(),
  timeLabel: z.string().optional(),
  /** WHY it costs more (customer-facing text from config). */
  explanation: z.string(),
  /** Surcharges sharing a group are mutually exclusive (e.g. overgrown vs severely overgrown). */
  exclusiveGroup: z.string().optional(),
  /** Per-unit surcharges take a quantity (e.g. excess square feet). */
  perUnit: z.object({ unitLabel: z.string(), maxQty: z.number().int().min(1) }).optional(),
  confirmOnSite: z.boolean().default(false),
});
export type ServiceSurchargeOption = z.infer<typeof ServiceSurchargeOption>;

export const ServiceFrequencyOption = z.object({
  code: ServiceFrequencyCode,
  name: z.string(),
  /** "5% off the base visit", absent for one-time. */
  discountLabel: z.string().optional(),
  note: z.string().optional(),
});
export type ServiceFrequencyOption = z.infer<typeof ServiceFrequencyOption>;

export const ServiceOptions = z.object({
  serviceCode: Code,
  name: z.string(),
  description: z.string(),
  includes: z.array(z.string()),
  /** Lowest tier price ("From $99.00"). */
  fromLabel: z.string(),
  tiers: z.array(ServiceTierOption).min(1),
  /** What the tier choice means for this service: "TV size", "Lot size", "Home size". */
  tierLabel: z.string(),
  addOnGroups: z.array(ServiceAddOnGroup),
  /** Heading for the surcharges: "Wall conditions", "Yard conditions"… */
  surchargeLabel: z.string(),
  surcharges: z.array(ServiceSurchargeOption),
  /** Always at least one-time. */
  frequencies: z.array(ServiceFrequencyOption).min(1),
  notes: z.array(z.string()),
});
export type ServiceOptions = z.infer<typeof ServiceOptions>;

// ---------------------------------------------------------------------------
// Card blocks
// ---------------------------------------------------------------------------

/** Pick a service configuration. One service (MountPro, GreenStripe) or several (BrightNest). */
export const ServicePickerBlock = z.object({
  type: z.literal("service_picker"),
  cardId: Id,
  services: z.array(ServiceOptions).min(1).max(5),
  /** Preselected configuration (e.g. the tier the customer described). */
  selected: ServiceConfig.optional(),
});

/** A server-computed price for one configuration, with an optional "change options" editor. */
export const QuoteCardBlock = z.object({
  type: z.literal("quote_card"),
  cardId: Id,
  config: ServiceConfig,
  serviceName: z.string(),
  tierName: z.string(),
  quote: Quote,
  durationMin: z.number().int().min(0),
  /** Lets the customer change the configuration in place. */
  options: ServiceOptions,
  /** Shown when the price is an estimate confirmed on arrival. */
  warnings: z.array(z.string()).default([]),
});

/** Open start times for one configuration; picking one opens the secure booking form. */
export const SlotSuggestionsBlock = z.object({
  type: z.literal("slot_suggestions"),
  cardId: Id,
  config: ServiceConfig,
  serviceName: z.string(),
  durationMin: z.number().int().min(0),
  timezone: z.string(),
  slots: z.array(SlotSummary).max(MAX_SLOT_SUGGESTIONS),
  /** Local date after the last listed slot, for "More times". Absent when none are left. */
  moreFrom: IsoDate.optional(),
});

/** The job is too long for one visit: no times, no checkout; offer a person. */
export const EstimateCardBlock = z.object({
  type: z.literal("estimate_card"),
  cardId: Id,
  serviceName: z.string(),
  reason: z.string(),
});

export const ProductStock = z.enum(["in_stock", "partial", "out_of_stock"]);
export type ProductStock = z.infer<typeof ProductStock>;

export const ProductCardItem = z.object({
  sku: Sku,
  name: z.string(),
  description: z.string(),
  priceCents: Cents,
  unit: z.string(),
  qtyOnHand: z.number().int().min(0),
  stock: ProductStock,
  /** Over 50 lb: extra handling, not in free shipping. */
  heavy: z.boolean(),
  /** For a stock check: how many the customer asked for. */
  requested: z.number().int().min(1).optional(),
  /** True for in-stock alternatives the tool suggested. */
  alternative: z.boolean().default(false),
});
export type ProductCardItem = z.infer<typeof ProductCardItem>;

/** Products from a search or stock check; each can be added to the order with a quantity. */
export const ProductCardsBlock = z.object({
  type: z.literal("product_cards"),
  cardId: Id,
  items: z
    .array(ProductCardItem)
    .min(1)
    .max(MAX_PRODUCT_CARDS * 2),
});

/** A priced cart (quote_products) that leads to the secure order form. */
export const CartSummaryBlock = z.object({
  type: z.literal("cart_summary"),
  cardId: Id,
  lines: z.array(
    z.object({
      sku: Sku,
      name: z.string(),
      qty: z.number().int().min(1),
      maxQty: z.number().int(),
    }),
  ),
  quote: Quote,
  /** Lines that could not be priced in full. */
  issues: z.array(z.string()).default([]),
});

export const CARD_TYPES = [
  "service_picker",
  "quote_card",
  "slot_suggestions",
  "estimate_card",
  "product_cards",
  "cart_summary",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

// ---------------------------------------------------------------------------
// Card actions (client → server, codes/qty/ids only)
// ---------------------------------------------------------------------------

const CartLines = z.array(ProductLineInput).min(1).max(25);

export const CardAction = z.discriminatedUnion("action", [
  /** Price this configuration (and list the next open times). */
  z.object({ action: z.literal("get_quote"), config: ServiceConfig }),
  /** Book this configuration at this start time: opens the secure booking form. */
  z.object({ action: z.literal("pick_slot"), config: ServiceConfig, slotId: Id }),
  /** More start times for this configuration from a local date on. */
  z.object({ action: z.literal("more_times"), config: ServiceConfig, fromDate: IsoDate }),
  /** Price a cart, optionally with a destination ZIP for shipping. */
  z.object({ action: z.literal("quote_cart"), lines: CartLines, zip: ZipCode.optional() }),
  /** Open the secure order form for this cart. */
  z.object({ action: z.literal("checkout_cart"), lines: CartLines }),
]);
export type CardAction = z.infer<typeof CardAction>;
export type CardActionName = CardAction["action"];
