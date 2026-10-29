/**
 * Interactive cards for a reply (src/contracts/cards.ts), built ONLY from this turn's
 * successful, schema-validated tool output plus src/config. The model never writes a card,
 * so every price, label, option and time on it is grounded the same way the tools are.
 *
 * Priority (at most MAX_CARDS_PER_REPLY, and none next to a checkout form):
 *   on-site estimate > quote (+ open times) > service picker > priced cart > product cards
 */
import "server-only";
import {
  CheckAvailabilityOutput,
  CheckInventoryOutput,
  GetProductOutput,
  MAX_CARDS_PER_REPLY,
  MAX_PRODUCT_CARDS,
  MAX_SLOT_SUGGESTIONS,
  QuoteProductsOutput,
  QuoteServiceOutput,
  SearchCatalogOutput,
  ServiceConfig,
  type ProductCardItem,
  type ProductSummary,
  type ServiceOptions,
  type SlotSummary,
  type UiBlock,
} from "@/contracts";
import { SHIPPING_RULES, getServiceDefinition } from "@/config/pricing";
import {
  buildServiceOptions,
  checkInventory,
  getProduct,
  serviceOptionsForBusiness,
} from "@/domain";
import { randomId } from "@/guard/crypto";
import { addDays, localDateString } from "@/lib/tz";

export interface CardToolCall {
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
}

type Card = Exclude<UiBlock, { type: "text" } | { type: "form" }>;
type Of<T extends Card["type"]> = Extract<Card, { type: T }>;

const cardId = () => randomId();

// ---------------------------------------------------------------------------
// Builders (also used by card-actions.ts)
// ---------------------------------------------------------------------------

export function servicePickerCard(
  businessId: string,
  selected?: ServiceConfig,
): Of<"service_picker"> | null {
  const services = serviceOptionsForBusiness(businessId);
  if (!services.length) return null;
  return {
    type: "service_picker",
    cardId: cardId(),
    services,
    ...(selected && services.some((s) => s.serviceCode === selected.serviceCode)
      ? { selected }
      : {}),
  };
}

type ServiceQuote = Extract<ReturnType<typeof QuoteServiceOutput.parse>, { quote: unknown }> & {
  tierName?: string;
};

/** quote_service output → quote card (or an estimate card for an over-long job). */
export function quoteCard(
  businessId: string,
  config: ServiceConfig,
  out: ServiceQuote,
): Of<"quote_card"> | Of<"estimate_card"> | null {
  const def = getServiceDefinition(businessId, config.serviceCode);
  const options: ServiceOptions | null = buildServiceOptions(businessId, config.serviceCode);
  if (!def || !options) return null;
  if (out.requiresOnSiteEstimate) return estimateCard(def.name, out.onSiteEstimateReason);
  const tier = def.tiers.find((t) => t.code.toLowerCase() === config.tierCode.toLowerCase());
  return {
    type: "quote_card",
    cardId: cardId(),
    config: { ...config, tierCode: tier?.code ?? config.tierCode },
    serviceName: def.name,
    tierName: out.tierName ?? tier?.name ?? config.tierCode,
    quote: out.quote,
    durationMin: out.quote.durationMin ?? 0,
    options,
    warnings: out.warnings,
  };
}

export function estimateCard(serviceName: string, reason?: string): Of<"estimate_card"> {
  return {
    type: "estimate_card",
    cardId: cardId(),
    serviceName,
    reason:
      reason ?? "This job is longer than one appointment day, so it needs an on-site estimate.",
  };
}

/** Open times for a priced configuration. Null when there are none to show. */
export function slotCard(
  businessId: string,
  config: ServiceConfig,
  durationMin: number,
  out: ReturnType<typeof CheckAvailabilityOutput.parse>,
): Of<"slot_suggestions"> | null {
  const def = getServiceDefinition(businessId, config.serviceCode);
  if (!def || out.requiresOnSiteEstimate) return null;
  const all: SlotSummary[] = out.slots.length ? out.slots : out.nextAvailable;
  const slots = all.slice(0, MAX_SLOT_SUGGESTIONS);
  if (!slots.length) return null;
  const last = slots[slots.length - 1]!;
  return {
    type: "slot_suggestions",
    cardId: cardId(),
    config,
    serviceName: def.name,
    durationMin,
    timezone: out.timezone,
    slots,
    moreFrom: addDays(localDateString(new Date(last.startsAt), out.timezone), 1),
  };
}

const heavy = (weightLb: number) => weightLb > SHIPPING_RULES.HEAVY_ITEM_LB;

function productItem(p: ProductSummary, extra: Partial<ProductCardItem> = {}): ProductCardItem {
  return {
    sku: p.sku,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    unit: p.unit,
    qtyOnHand: Math.max(0, p.qtyOnHand),
    stock: p.qtyOnHand > 0 ? "in_stock" : "out_of_stock",
    heavy: heavy(p.weightLb),
    alternative: false,
    ...extra,
  };
}

export function productCards(items: ProductCardItem[]): Of<"product_cards"> | null {
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.sku) ? false : (seen.add(i.sku), true)));
  if (!unique.length) return null;
  return { type: "product_cards", cardId: cardId(), items: unique.slice(0, MAX_PRODUCT_CARDS * 2) };
}

/** Stock-check output → the asked-for items (live status) plus in-stock alternatives. */
async function inventoryItems(
  businessId: string,
  out: ReturnType<typeof CheckInventoryOutput.parse>,
): Promise<ProductCardItem[]> {
  const items: ProductCardItem[] = [];
  for (const line of out.items.slice(0, MAX_PRODUCT_CARDS)) {
    if (line.status === "not_found") continue;
    const found = await getProduct(businessId, line.sku);
    if ("product" in found) {
      items.push(
        productItem(found.product, {
          qtyOnHand: line.available,
          stock: line.status,
          requested: line.requested,
        }),
      );
    }
    for (const a of line.alternatives.slice(0, 3)) {
      if (a.sku !== line.sku) items.push(productItem(a, { alternative: true }));
    }
  }
  return items;
}

/** quote_products output → priced cart card (names and stock limits from the live catalog). */
export async function cartCard(
  businessId: string,
  out: Extract<ReturnType<typeof QuoteProductsOutput.parse>, { quote: unknown }>,
): Promise<Of<"cart_summary"> | null> {
  const goods = out.quote.lines.filter((l) => l.kind === "goods");
  if (!goods.length) return null;
  const stock = await checkInventory(
    businessId,
    goods.map((g) => ({ sku: g.code, qty: g.qty })),
  );
  const available = new Map(stock.items.map((i) => [i.sku, i.available]));
  const issues = out.issues.map((i) =>
    i.problem === "not_found"
      ? `${i.sku} isn't in this catalog.`
      : i.problem === "out_of_stock"
        ? `${i.sku} is out of stock.`
        : `${i.sku}: only ${i.available ?? 0} available, priced at that quantity.`,
  );
  return {
    type: "cart_summary",
    cardId: cardId(),
    lines: goods.map((g) => ({
      sku: g.code,
      name: g.label,
      qty: g.qty,
      maxQty: Math.max(g.qty, available.get(g.code) ?? g.qty),
    })),
    quote: out.quote,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Cards for a model turn
// ---------------------------------------------------------------------------

const lastOk = (calls: CardToolCall[], name: string) =>
  [...calls].reverse().find((c) => c.ok && c.name === name);

function configOf(input: unknown): ServiceConfig | null {
  if (!input || typeof input !== "object") return null;
  const { reason: _r, ...rest } = input as Record<string, unknown>;
  const p = ServiceConfig.safeParse(rest);
  return p.success ? p.data : null;
}

/**
 * The cards for one model turn, from its tool calls. Empty when a checkout form was opened
 * (the form is the next step) or when no tool produced something a card can show.
 */
export async function cardsForTurn(
  businessId: string,
  kind: "product" | "service",
  calls: CardToolCall[],
  hasForm: boolean,
): Promise<Card[]> {
  if (hasForm) return [];
  const cards: Card[] = [];
  const push = (c: Card | null) => {
    if (c && cards.length < MAX_CARDS_PER_REPLY) cards.push(c);
  };

  if (kind === "service") {
    const q = lastOk(calls, "quote_service");
    const quoted = q ? QuoteServiceOutput.safeParse(q.output) : null;
    const config = q ? configOf(q.input) : null;
    if (quoted?.success && "quote" in quoted.data && config) {
      const card = quoteCard(businessId, config, quoted.data as ServiceQuote);
      push(card);
      if (card?.type === "quote_card") {
        const a = lastOk(calls, "check_availability");
        const avail = a ? CheckAvailabilityOutput.safeParse(a.output) : null;
        if (avail?.success) push(slotCard(businessId, card.config, card.durationMin, avail.data));
      }
      return cards;
    }
    const a = lastOk(calls, "check_availability");
    const avail = a ? CheckAvailabilityOutput.safeParse(a.output) : null;
    if (avail?.success && avail.data.requiresOnSiteEstimate) {
      const code = (a?.input as { serviceCode?: string } | undefined)?.serviceCode ?? "";
      push(estimateCard(getServiceDefinition(businessId, code)?.name ?? "This job"));
      return cards;
    }
    // Open times without a priced configuration cannot be booked from a card: show the
    // picker so the customer chooses the specs first (it then lists matching times).
    if (
      lastOk(calls, "list_services") ||
      lastOk(calls, "search_catalog") ||
      avail?.success ||
      calls.some((c) => c.name === "quote_service")
    ) {
      push(servicePickerCard(businessId));
    }
    return cards;
  }

  // Products
  const qp = lastOk(calls, "quote_products");
  const quoted = qp ? QuoteProductsOutput.safeParse(qp.output) : null;
  if (quoted?.success && "quote" in quoted.data) push(await cartCard(businessId, quoted.data));
  const inv = lastOk(calls, "check_inventory");
  const invOut = inv ? CheckInventoryOutput.safeParse(inv.output) : null;
  if (invOut?.success) {
    push(productCards(await inventoryItems(businessId, invOut.data)));
    return cards;
  }
  const items: ProductCardItem[] = [];
  for (const c of calls) {
    if (!c.ok) continue;
    if (c.name === "search_catalog") {
      const s = SearchCatalogOutput.safeParse(c.output);
      if (s.success) items.push(...s.data.results.map((p) => productItem(p)));
    } else if (c.name === "get_product") {
      const g = GetProductOutput.safeParse(c.output);
      if (g.success && "product" in g.data) items.push(productItem(g.data.product));
    }
  }
  push(productCards(items.slice(0, MAX_PRODUCT_CARDS)));
  return cards;
}
