/**
 * Agent tool contracts (SPEC §7). Every tool input carries a required short `reason`
 * (shown as "why" in the trace panel). `businessId` is NEVER part of a tool input — the
 * server injects it from the conversation record.
 */
import { z } from "zod";
import {
  Cents,
  CheckoutKind,
  Code,
  Email,
  Id,
  IsoDate,
  IsoDateTime,
  Reference,
  Sku,
} from "./common";
import { ZipCode } from "./customer";
import {
  ProductLineInput,
  Quote,
  ServiceConfig,
  ServiceFrequencyCode,
  ServiceSelection,
  SlotSummary,
} from "./checkout";

export const TOOL_NAMES = [
  "search_catalog",
  "get_product",
  "check_inventory",
  "quote_products",
  "list_services",
  "quote_service",
  "check_availability",
  "check_service_area",
  "get_policies",
  "start_checkout",
  "lookup_status",
  "escalate_to_support",
] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

export const Reason = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .describe("One short sentence: why you are calling this tool (shown to the customer).");

const NotFound = z.object({
  notFound: z.literal(true),
  message: z.string(),
});

// ----- Products ---------------------------------------------------------------

export const ProductSummary = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  priceCents: Cents,
  unit: z.string(),
  weightLb: z.number(),
  qtyOnHand: z.number().int(),
  inStock: z.boolean(),
});
export type ProductSummary = z.infer<typeof ProductSummary>;

export const SearchCatalogInput = z.object({
  reason: Reason,
  query: z.string().trim().max(100).default("").describe("Keywords; empty lists the catalog"),
  category: z.string().trim().max(60).optional(),
  limit: z.number().int().min(1).max(25).default(10),
});
export const SearchCatalogOutput = z.object({
  results: z.array(ProductSummary),
  total: z.number().int(),
  categories: z.array(z.string()),
  /** Service businesses: matching services (`results` is then empty). */
  services: z
    .array(
      z.object({
        code: z.string(),
        name: z.string(),
        description: z.string(),
        fromPriceCents: Cents,
      }),
    )
    .optional(),
});

export const GetProductInput = z.object({ reason: Reason, sku: Sku });
export const GetProductOutput = z.union([
  z.object({ product: ProductSummary }),
  NotFound.extend({ sku: z.string() }),
]);

export const InventoryStatus = z.enum(["in_stock", "partial", "out_of_stock", "not_found"]);
export const CheckInventoryInput = z.object({
  reason: Reason,
  items: z.array(ProductLineInput).min(1).max(25),
});
export const CheckInventoryOutput = z.object({
  items: z.array(
    z.object({
      sku: z.string(),
      name: z.string().optional(),
      requested: z.number().int(),
      available: z.number().int().min(0),
      status: InventoryStatus,
      alternatives: z.array(ProductSummary).default([]),
    }),
  ),
});

export const QuoteProductsInput = z.object({
  reason: Reason,
  lines: z.array(ProductLineInput).min(1).max(50),
  zip: ZipCode.optional().describe("Destination ZIP for shipping; omit to quote goods only"),
});
export const QuoteProductsOutput = z.union([
  z.object({
    quote: Quote,
    /** Lines that could not be priced in full (unknown SKU, insufficient stock). */
    issues: z.array(
      z.object({
        sku: z.string(),
        problem: z.enum(["not_found", "insufficient_stock", "out_of_stock"]),
        available: z.number().int().optional(),
      }),
    ),
  }),
  NotFound,
]);

// ----- Services -----------------------------------------------------------------

export const ListServicesInput = z.object({ reason: Reason });
export const ListServicesOutput = z.object({
  services: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      description: z.string(),
      includes: z.array(z.string()),
      tiers: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          description: z.string(),
          priceCents: Cents,
          durationMin: z.number().int(),
          extraUnit: z
            .object({
              name: z.string(),
              priceCents: Cents,
              minutes: z.number().int(),
              maxQty: z.number().int(),
            })
            .optional(),
        }),
      ),
      addOns: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          description: z.string(),
          priceCents: Cents,
          minutes: z.number().int(),
          taxable: z.boolean(),
          maxQty: z.number().int(),
        }),
      ),
      surcharges: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          condition: z.string(),
          price: z.string().describe("e.g. '+$100' or '+50% of base'"),
          minutes: z.number().int(),
          explanation: z.string(),
        }),
      ),
      frequencies: z.array(
        z.object({ code: ServiceFrequencyCode, name: z.string(), discountPercent: z.number() }),
      ),
      notes: z.array(z.string()),
    }),
  ),
});

export const QuoteServiceInput = ServiceConfig.extend({ reason: Reason });
export const QuoteServiceOutput = z.union([
  z.object({
    serviceCode: z.string(),
    tierCode: z.string(),
    quote: Quote,
    /** Explanations for each applied surcharge (answering "why"). */
    surchargeExplanations: z.array(z.object({ code: z.string(), explanation: z.string() })),
    warnings: z.array(z.string()),
    /**
     * True when the job is longer than the longest bookable business day: it cannot be booked
     * online (start_checkout refuses) and needs an on-site estimate — offer escalation.
     */
    requiresOnSiteEstimate: z.boolean().optional(),
    /** Customer-facing explanation when `requiresOnSiteEstimate`. */
    onSiteEstimateReason: z.string().optional(),
  }),
  NotFound,
]);

export const CheckAvailabilityInput = z.object({
  reason: Reason,
  serviceCode: Code,
  /** Total job minutes from quote_service; determines how many consecutive slots are needed. */
  durationMin: z.number().int().min(15).max(720).optional(),
  date: IsoDate.optional().describe("A single local date YYYY-MM-DD"),
  fromDate: IsoDate.optional(),
  toDate: IsoDate.optional(),
  limit: z.number().int().min(1).max(20).default(6),
});
export const CheckAvailabilityOutput = z.object({
  timezone: z.string(),
  requestedDate: z.string().optional(),
  /** True when a specific date was requested and has no slot long enough. */
  fullyBooked: z.boolean(),
  slots: z.array(SlotSummary),
  /** When the requested date is full: the nearest open slots after it. */
  nextAvailable: z.array(SlotSummary).default([]),
  /** True when the requested date is a day the business does not take appointments. */
  closed: z.boolean().optional(),
  /** True when the job is longer than any business day (needs an on-site estimate). */
  requiresOnSiteEstimate: z.boolean().optional(),
  message: z.string().optional(),
});

export const CheckServiceAreaInput = z.object({ reason: Reason, zip: ZipCode });
export const CheckServiceAreaOutput = z.object({
  zip: z.string(),
  served: z.boolean(),
  message: z.string(),
});

// ----- Policies / checkout / status / escalation ---------------------------------

export const GetPoliciesInput = z.object({
  reason: Reason,
  topic: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe("Policy key, e.g. returns, shipping, cancellation, warranty, hours; omit for all"),
});
export const GetPoliciesOutput = z.object({
  businessName: z.string(),
  policies: z.array(z.object({ key: z.string(), title: z.string(), text: z.string() })),
  hours: z.array(z.object({ day: z.string(), open: z.string(), close: z.string() })),
});

export const StartCheckoutInput = z.discriminatedUnion("kind", [
  z.object({
    reason: Reason,
    kind: z.literal("product"),
    lines: z.array(ProductLineInput).min(1).max(50),
  }),
  z.object({ reason: Reason, kind: z.literal("service"), selection: ServiceSelection }),
]);
export const StartCheckoutOutput = z.union([
  z.object({
    draftId: Id,
    kind: CheckoutKind,
    summary: z.string(),
    quote: Quote,
    expiresAt: IsoDateTime,
  }),
  z.object({
    error: z.enum([
      "unknown_sku",
      "unknown_service",
      "out_of_stock",
      "insufficient_stock",
      "slot_unavailable",
      "invalid_selection",
      /** Job longer than a business day: cannot be booked online; offer escalation. */
      "requires_on_site_estimate",
    ]),
    message: z.string(),
  }),
]);

export const LookupStatusInput = z.object({ reason: Reason, reference: Reference, email: Email });
export const LookupStatusOutput = z.union([
  z.object({
    found: z.literal(true),
    kind: CheckoutKind,
    reference: z.string(),
    status: z.string(),
    totalCents: Cents,
    createdAt: IsoDateTime,
    /** Bookings: appointment time in the business timezone. */
    appointment: z.string().optional(),
    /** Bookings: human service name, e.g. "Lawn mowing visit" (never the raw code). */
    serviceName: z.string().optional(),
    /** Orders: "1 item" / "3 items". */
    itemsLabel: z.string().optional(),
    summary: z.string(),
  }),
  z.object({ found: z.literal(false), message: z.string() }),
]);

export const EscalationReason = z.enum([
  "requested_human",
  "frustration",
  "unresolved",
  "complaint",
  "other",
]);
export const EscalateToSupportInput = z.object({
  reason: Reason,
  category: EscalationReason,
  summary: z
    .string()
    .trim()
    .min(10)
    .max(1500)
    .describe("Brief summary of the conversation and what the customer needs. No contact details."),
});
export const EscalateToSupportOutput = z.object({
  escalated: z.literal(true),
  ticketId: z.string(),
  supportEmail: z.string(),
  responseTime: z.string(),
});

/** Registry: name → schemas + friendly trace label. */
export const TOOL_SCHEMAS = {
  search_catalog: {
    input: SearchCatalogInput,
    output: SearchCatalogOutput,
    label: "Searched the catalog",
  },
  get_product: { input: GetProductInput, output: GetProductOutput, label: "Looked up a product" },
  check_inventory: {
    input: CheckInventoryInput,
    output: CheckInventoryOutput,
    label: "Checked live inventory",
  },
  quote_products: {
    input: QuoteProductsInput,
    output: QuoteProductsOutput,
    label: "Priced the order",
  },
  list_services: {
    input: ListServicesInput,
    output: ListServicesOutput,
    label: "Listed services and prices",
  },
  quote_service: {
    input: QuoteServiceInput,
    output: QuoteServiceOutput,
    label: "Priced the service",
  },
  check_availability: {
    input: CheckAvailabilityInput,
    output: CheckAvailabilityOutput,
    label: "Checked availability",
  },
  check_service_area: {
    input: CheckServiceAreaInput,
    output: CheckServiceAreaOutput,
    label: "Checked the service area",
  },
  get_policies: {
    input: GetPoliciesInput,
    output: GetPoliciesOutput,
    label: "Read store policies",
  },
  start_checkout: {
    input: StartCheckoutInput,
    output: StartCheckoutOutput,
    label: "Prepared secure checkout",
  },
  lookup_status: {
    input: LookupStatusInput,
    output: LookupStatusOutput,
    label: "Looked up order status",
  },
  escalate_to_support: {
    input: EscalateToSupportInput,
    output: EscalateToSupportOutput,
    label: "Escalated to a person",
  },
} as const satisfies Record<ToolName, { input: z.ZodType; output: z.ZodType; label: string }>;

export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]["input"]>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]["output"]>;
