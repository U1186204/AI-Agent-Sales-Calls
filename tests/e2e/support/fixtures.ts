/**
 * Mock API payloads for UI e2e tests. Every payload is validated against the shared
 * contracts / UI schemas in `mocks.ts`, so the mocks can't drift from what the UI parses.
 */
import type {
  ChatResponse,
  CheckoutDraftView,
  CheckoutReview,
  DraftSelectionUpdated,
  Quote,
  ServiceConfig,
  SlotSummary,
  TraceStep,
} from "../../../src/contracts";
import { buildServiceOptions } from "../../../src/domain/service-options";

const DAY = 86_400_000;
export const isoDay = (offset: number) =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

export const REFERENCE = "OAS-7K3M-Q9TD";
export const DRAFT_PRODUCT = "draft_prod_1";
export const DRAFT_SERVICE = "draft_svc_1";
export const CONVERSATION = "conv_test_1";

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export const TRACE_INVENTORY: TraceStep[] = [
  {
    id: "s1",
    kind: "tool",
    tool: "search_catalog",
    label: "Searched the catalog",
    why: "The customer asked for 12/2 Romex, so I looked up matching wire.",
    input: { query: "12/2 romex", limit: 5 },
    outputSummary: "Found 2 products: Romex 12/2 NM-B w/G, 250 ft and Romex 12/3 NM-B w/G, 250 ft.",
    dataRefs: [
      { type: "sku", id: "EL-NM122-250" },
      { type: "sku", id: "EL-NM123-250" },
    ],
    ok: true,
    ms: 42,
  },
  {
    id: "s2",
    kind: "tool",
    tool: "check_inventory",
    label: "Checked live inventory",
    why: "To confirm there is enough stock for two rolls before quoting.",
    input: { items: [{ sku: "EL-NM122-250", qty: 2 }] },
    outputSummary: "EL-NM122-250: 2 requested, 38 on hand. In stock.",
    dataRefs: [{ type: "sku", id: "EL-NM122-250" }],
    ok: true,
    ms: 18,
  },
];

export const USAGE = {
  model: "claude-haiku-4-5",
  inputTokens: 3120,
  outputTokens: 214,
  costUsd: 0.0042,
  toolRounds: 2,
};

export function chatText(
  text: string,
  trace: TraceStep[] = [],
  extra: Partial<ChatResponse> = {},
): ChatResponse {
  return {
    conversationId: CONVERSATION,
    blocks: [{ type: "text", text }],
    trace,
    usage: USAGE,
    fallback: false,
    offerEscalation: false,
    ...extra,
  };
}

export const REPLY_STOCK = chatText(
  "Yes — **Romex 12/2 NM-B w/G, 250 ft** is in stock (38 rolls) at $129.99 each.\n\n- Two rolls come to $259.98 before tax\n- Orders over $249 ship free by ground\n\nWant me to set up checkout for two rolls?",
  TRACE_INVENTORY,
);

export const REPLY_PRODUCT_FORM: ChatResponse = {
  conversationId: CONVERSATION,
  blocks: [
    {
      type: "text",
      text: "Great. I've prepared a secure checkout for two rolls. Enter your details in the form below.",
    },
    {
      type: "form",
      draftId: DRAFT_PRODUCT,
      kind: "product",
      summary: "2 × Romex 12/2 NM-B w/G, 250 ft (EL-NM122-250)",
    },
  ],
  trace: [
    {
      id: "s3",
      kind: "tool",
      tool: "start_checkout",
      label: "Prepared secure checkout",
      why: "The customer confirmed two rolls and is ready to buy.",
      input: { kind: "product", lines: [{ sku: "EL-NM122-250", qty: 2 }] },
      outputSummary: "Checkout draft ready. Expires in 30 minutes.",
      dataRefs: [
        { type: "draft", id: DRAFT_PRODUCT },
        { type: "sku", id: "EL-NM122-250" },
      ],
      ok: true,
      ms: 61,
    },
  ],
  usage: USAGE,
  fallback: false,
  offerEscalation: false,
};

export const REPLY_SERVICE_FORM: ChatResponse = {
  conversationId: CONVERSATION,
  blocks: [
    {
      type: "text",
      text: "Here's a secure booking form. I've held the earliest time; you can pick another.",
    },
    {
      type: "form",
      draftId: DRAFT_SERVICE,
      kind: "service",
      summary:
        'TV wall mounting — Large (56"–70") + Tilting mount supplied, Above fireplace (about 2 hr 30 min)',
    },
  ],
  trace: [
    {
      id: "s4",
      kind: "tool",
      tool: "check_availability",
      label: "Checked availability",
      why: "To find the earliest opening long enough for a 2.5 hour job.",
      input: { serviceCode: "tv-mounting", durationMin: 150, fromDate: isoDay(1) },
      outputSummary: "4 open start times on the first available day.",
      dataRefs: [{ type: "slot", id: "slot-1" }],
      ok: true,
      ms: 27,
    },
  ],
  usage: USAGE,
  fallback: false,
  offerEscalation: false,
};

export const REPLY_CONFIRMED = chatText(
  `You're all set! Your order ${REFERENCE} is confirmed. A confirmation email is on its way.`,
);

export const REPLY_HUMAN = chatText(
  "I've passed this conversation to our support team. Someone will email you within 1 business day.",
  [
    {
      id: "s5",
      kind: "tool",
      tool: "escalate_to_support",
      label: "Escalated to a person",
      why: "The customer asked to talk to a person.",
      input: { category: "requested_human" },
      outputSummary: "Support ticket created; the team replies within 1 business day.",
      dataRefs: [{ type: "ticket", id: "T-1042" }],
      ok: true,
      ms: 33,
    },
  ],
);

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

const TAX_DISCLAIMER =
  "Demo tax: 7.5% on goods and materials; labor and shipping untaxed. Real tax depends on your location. Demo tax rule — not tax advice.";

export const PRODUCT_QUOTE: Quote = {
  currency: "USD",
  lines: [
    {
      kind: "goods",
      code: "EL-NM122-250",
      label: "Romex 12/2 NM-B w/G, 250 ft",
      qty: 2,
      unitCents: 12999,
      amountCents: 25998,
      taxable: true,
    },
  ],
  subtotalCents: 25998,
  discountCents: 0,
  shippingCents: 0,
  taxableCents: 25998,
  taxRateBps: 750,
  taxCents: 1950,
  totalCents: 27948,
  notes: [],
  taxDisclaimer: TAX_DISCLAIMER,
};

const expires = () => new Date(Date.now() + 25 * 60_000).toISOString();

export const productDraft = (): CheckoutDraftView => ({
  draftId: DRAFT_PRODUCT,
  kind: "product",
  businessId: "volt-supply",
  businessName: "Volt & Wire Electrical Supply",
  summary: "2 × Romex 12/2 NM-B w/G, 250 ft (EL-NM122-250)",
  status: "open",
  quote: PRODUCT_QUOTE,
  items: [{ sku: "EL-NM122-250", name: "Romex 12/2 NM-B w/G, 250 ft", qty: 2, lineCents: 25998 }],
  expiresAt: expires(),
});

export const productReview = (): CheckoutReview => ({
  draftId: DRAFT_PRODUCT,
  kind: "product",
  businessId: "volt-supply",
  businessName: "Volt & Wire Electrical Supply",
  customer: {
    name: "Ana Rivera",
    emailMasked: "a***@example.com",
    phoneMasked: "(•••) •••-0123",
    addressSummary: "Anchorage, AK 99501",
  },
  quote: {
    ...PRODUCT_QUOTE,
    shipZone: 8,
    shipZip: "99501",
    notes: ["Free ground shipping applied (goods subtotal $249 or more)"],
  },
  items: [{ sku: "EL-NM122-250", name: "Romex 12/2 NM-B w/G, 250 ft", qty: 2, lineCents: 25998 }],
  expiresAt: expires(),
  warnings: [],
});

const TZ = "America/Denver";

/** Weekdays in the next 21 days, skipping the first weekday (fully booked fixture). */
export function availableDates(): string[] {
  const out: string[] = [];
  let skipped = false;
  for (let i = 1; i <= 21; i++) {
    const d = isoDay(i);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow === 0) continue;
    if (!skipped) {
      skipped = true;
      continue;
    }
    out.push(d);
  }
  return out;
}

/** Slot at a local hour (fixture uses a fixed UTC-6 offset; Denver in daylight time). */
export function slotFor(date: string, hour: number): SlotSummary {
  const h12 = hour > 12 ? hour - 12 : hour;
  const ampm = hour >= 12 ? "PM" : "AM";
  const startsAt = `${date}T${String(hour + 6).padStart(2, "0")}:00:00Z`;
  const endsAt = `${date}T${String(hour + 8).padStart(2, "0")}:30:00Z`;
  return {
    slotId: `slot-${date}-${hour}`,
    startsAt,
    endsAt,
    localDate: new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
    localTime: `${h12}:00 ${ampm}`,
    timezone: TZ,
    contractor: "Marcus T.",
  };
}

export const SLOT_HOURS = [9, 10, 13, 15];

export const SERVICE_QUOTE: Quote = {
  currency: "USD",
  lines: [
    {
      kind: "service",
      code: "L",
      label: 'TV wall mounting — Large (56"–70")',
      qty: 1,
      unitCents: 14900,
      amountCents: 14900,
      taxable: false,
      minutes: 75,
    },
    {
      kind: "addon",
      code: "mount-tilt",
      label: "Tilting mount supplied",
      qty: 1,
      unitCents: 7900,
      amountCents: 7900,
      taxable: true,
      minutes: 0,
    },
    {
      kind: "surcharge",
      code: "above-fireplace",
      label: "Above fireplace",
      qty: 1,
      unitCents: 10000,
      amountCents: 10000,
      taxable: false,
      minutes: 75,
      note: "Extra time to locate studs and route cables around the firebox",
    },
  ],
  subtotalCents: 32800,
  discountCents: 0,
  shippingCents: 0,
  taxableCents: 7900,
  taxRateBps: 750,
  taxCents: 593,
  totalCents: 33393,
  durationMin: 150,
  notes: [],
  taxDisclaimer: TAX_DISCLAIMER,
};

/** The configuration behind SERVICE_QUOTE (Large TV, tilting mount, above a fireplace). */
export const SERVICE_CONFIG: ServiceConfig = {
  serviceCode: "tv-mounting",
  tierCode: "L",
  extraUnits: 0,
  addOns: [{ code: "mount-tilt", qty: 1 }],
  surcharges: [{ code: "above-fireplace", qty: 1 }],
  frequency: "one_time",
};

export const serviceDraft = (): CheckoutDraftView => {
  const dates = availableDates();
  const first = dates[0]!;
  return {
    draftId: DRAFT_SERVICE,
    kind: "service",
    businessId: "mountpro-tv",
    businessName: "MountPro TV Installation",
    summary:
      'TV wall mounting — Large (56"–70") + Tilting mount supplied, Above fireplace (about 2 hr 30 min)',
    status: "open",
    quote: SERVICE_QUOTE,
    service: {
      code: "tv-mounting",
      name: "TV wall mounting",
      tierName: 'Large (56"–70")',
      durationMin: 150,
      timezone: TZ,
      slot: slotFor(first, 10),
      config: SERVICE_CONFIG,
      options: buildServiceOptions("mountpro-tv", "tv-mounting")!,
    },
    availability: { timezone: TZ, fromDate: isoDay(1), toDate: isoDay(45), dates },
    expiresAt: expires(),
  };
};

/**
 * The draft after "Service details" changes: the mock server's answer to PATCH. Adding an
 * in-wall concealment kit makes the job longer (195 min) and the price higher; with
 * `fewerDates` the first available day drops out (the longer job no longer fits it).
 */
export const serviceDraftUpdated = (
  config: ServiceConfig,
  opts: { fewerDates?: boolean } = {},
): DraftSelectionUpdated => {
  const base = serviceDraft();
  const concealed = config.addOns.some((a) => a.code === "in-wall-concealment");
  const extraCents = concealed ? 14900 : 0;
  const extraTax = concealed ? 1118 : 0;
  const durationMin = 150 + (concealed ? 45 : 0);
  const dates = opts.fewerDates ? base.availability!.dates.slice(1) : base.availability!.dates;
  return {
    draft: {
      ...base,
      summary: concealed ? `${base.summary} + In-wall cable concealment` : base.summary,
      quote: {
        ...SERVICE_QUOTE,
        lines: concealed
          ? [
              ...SERVICE_QUOTE.lines,
              {
                kind: "addon",
                code: "in-wall-concealment",
                label: "In-wall cable concealment",
                qty: 1,
                unitCents: 14900,
                amountCents: 14900,
                taxable: true,
                minutes: 45,
              },
            ]
          : SERVICE_QUOTE.lines,
        subtotalCents: SERVICE_QUOTE.subtotalCents + extraCents,
        taxableCents: SERVICE_QUOTE.taxableCents + extraCents,
        taxCents: SERVICE_QUOTE.taxCents + extraTax,
        totalCents: SERVICE_QUOTE.totalCents + extraCents + extraTax,
        durationMin,
      },
      service: {
        ...base.service!,
        durationMin,
        config,
        slot: opts.fewerDates ? null : base.service!.slot,
      },
      availability: { ...base.availability!, dates },
    },
    slotCleared: Boolean(opts.fewerDates),
  };
};

export const serviceReview = (slotId: string): CheckoutReview => {
  const date = /^slot-(\d{4}-\d{2}-\d{2})-/.exec(slotId)?.[1] ?? isoDay(2);
  const hour = Number(/-(\d+)$/.exec(slotId)?.[1] ?? 10);
  return {
    draftId: DRAFT_SERVICE,
    kind: "service",
    businessId: "mountpro-tv",
    businessName: "MountPro TV Installation",
    customer: {
      name: "Jordan Lee",
      emailMasked: "j***@example.com",
      phoneMasked: "(•••) •••-0188",
      addressSummary: "Denver, CO 80202",
    },
    quote: SERVICE_QUOTE,
    service: {
      code: "tv-mounting",
      name: "TV wall mounting",
      tierName: 'Large (56"–70")',
      slot: slotFor(date, hour),
    },
    expiresAt: expires(),
    warnings: ["Final price confirmed on site if the wall is brick or stone."],
  };
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const STATUS_FOUND = {
  found: true as const,
  kind: "product" as const,
  reference: REFERENCE,
  status: "shipped",
  totalCents: 27948,
  createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
  itemsLabel: "2 items",
  summary:
    "2 × Romex 12/2 NM-B w/G, 250 ft from Volt & Wire Electrical Supply, shipping to Anchorage, AK.",
};

export const STATUS_NOT_FOUND = {
  found: false as const,
  message: "We couldn't find an order or booking with that reference and email.",
};

// ---------------------------------------------------------------------------
// Guided cards (server-built in the app; mirrored here with the same option builder)
// ---------------------------------------------------------------------------

const TV_OPTIONS = buildServiceOptions("mountpro-tv", "tv-mounting")!;

const cardReply = (
  text: string,
  cards: ChatResponse["blocks"],
  extra: Partial<ChatResponse> = {},
) => chatText(text, TRACE_INVENTORY, { ...extra, blocks: [{ type: "text", text }, ...cards] });

export const REPLY_SERVICE_PICKER = cardReply(
  "Here are our options. Pick what fits and I'll price it with the next open times.",
  [{ type: "service_picker", cardId: "card_picker_1", services: [TV_OPTIONS] }],
);

export const REPLY_QUOTE_TIMES = (): ChatResponse => {
  const dates = availableDates();
  return cardReply(
    "That comes to $333.93 with estimated tax, about 2 hr 30 min on site. Pick a time below to book it.",
    [
      {
        type: "quote_card",
        cardId: "card_quote_1",
        config: SERVICE_CONFIG,
        serviceName: "TV wall mounting",
        tierName: 'Large (56"–70")',
        quote: SERVICE_QUOTE,
        durationMin: 150,
        options: TV_OPTIONS,
        warnings: [],
      },
      {
        type: "slot_suggestions",
        cardId: "card_times_1",
        config: SERVICE_CONFIG,
        serviceName: "TV wall mounting",
        durationMin: 150,
        timezone: TZ,
        slots: [slotFor(dates[0]!, 9), slotFor(dates[0]!, 13), slotFor(dates[1]!, 10)],
        moreFrom: dates[2]!,
      },
    ],
  );
};

export const REPLY_ESTIMATE = cardReply(
  "That job is longer than one visit, so it needs an on-site estimate. A person from our team can set that up.",
  [
    {
      type: "estimate_card",
      cardId: "card_estimate_1",
      serviceName: "Move-in / move-out cleaning",
      reason: "This job is about 13 hours, longer than our longest working day (10 hours).",
    },
  ],
  { offerEscalation: true },
);

export const REPLY_PRODUCTS = cardReply(
  "Only 3 are in stock; here are in-stock alternatives too.",
  [
    {
      type: "product_cards",
      cardId: "card_products_1",
      items: [
        {
          sku: "EL-WIR-1222-250",
          name: "Romex 12/2 NM-B w/G, 250 ft",
          description: "12 AWG two-conductor cable with ground.",
          priceCents: 12999,
          unit: "roll",
          qtyOnHand: 3,
          stock: "partial",
          heavy: false,
          requested: 5,
          alternative: false,
        },
        {
          sku: "EL-WIR-1223-250",
          name: "Romex 12/3 NM-B w/G, 250 ft",
          description: "12 AWG three-conductor cable with ground.",
          priceCents: 21999,
          unit: "roll",
          qtyOnHand: 0,
          stock: "out_of_stock",
          heavy: false,
          alternative: true,
        },
        {
          sku: "EL-WIR-1422-250",
          name: "Romex 14/2 NM-B w/G, 250 ft",
          description: "14 AWG two-conductor cable with ground.",
          priceCents: 8999,
          unit: "roll",
          qtyOnHand: 55,
          stock: "in_stock",
          heavy: false,
          alternative: true,
        },
      ],
    },
  ],
);

export const CART_QUOTE: Quote = {
  currency: "USD",
  lines: [
    {
      kind: "goods",
      code: "EL-WIR-1222-250",
      label: "Romex 12/2 NM-B w/G, 250 ft",
      qty: 2,
      unitCents: 12999,
      amountCents: 25998,
      taxable: true,
    },
  ],
  subtotalCents: 25998,
  discountCents: 0,
  shippingCents: 0,
  taxableCents: 25998,
  taxRateBps: 750,
  taxCents: 1950,
  totalCents: 27948,
  notes: [],
  taxDisclaimer: TAX_DISCLAIMER,
};

export const REPLY_CART = cardReply(
  "Your order comes to $279.48 with estimated tax, before shipping.",
  [
    {
      type: "cart_summary",
      cardId: "card_cart_1",
      lines: [{ sku: "EL-WIR-1222-250", name: "Romex 12/2 NM-B w/G, 250 ft", qty: 2, maxQty: 3 }],
      quote: CART_QUOTE,
      issues: [],
    },
  ],
);
