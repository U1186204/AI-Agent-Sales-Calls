/**
 * Catalog, business profile, services, policies and service area. Every query filters by
 * `businessId` (SPEC §4 data-isolation rule).
 */
import type { z } from "zod";
import {
  ServiceConfig,
  type GetProductOutput,
  type GetPoliciesOutput,
  type ListServicesOutput,
  type ProductSummary,
  type QuoteServiceOutput,
  type CheckServiceAreaOutput,
  type SearchCatalogOutput,
} from "@/contracts";
import type { BusinessKind, DayHours, ServiceArea } from "@/config/businesses";
import { getServiceDefinition, servicesForBusiness } from "@/config/pricing";
import { BUSINESSES, requireBusiness } from "./business";
import { db } from "./db";
import { onSiteEstimateReason, requiresOnSiteEstimate } from "./hours";
import { priceService, surchargePriceLabel } from "./pricing";

type Out<T extends z.ZodType> = z.output<T>;

export interface BusinessListing {
  id: string;
  name: string;
  shortName: string;
  kind: BusinessKind;
  tagline: string;
  description: string;
  timezone: string;
}

export interface PublicBusinessProfile extends BusinessListing {
  supportEmail: string;
  escalationResponse: string;
  serviceArea: { mode: "any" } | { mode: "zipPrefixes"; prefixes: string[] };
  supportHours: { day: string; open: string; close: string }[];
  bookingHours: { day: string; open: string; close: string }[];
  policyKeys: string[];
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hoursView = (h: readonly DayHours[]) =>
  h.map((x) => ({ day: DAY_NAMES[x.day] ?? String(x.day), open: x.open, close: x.close }));

export async function listBusinesses(): Promise<BusinessListing[]> {
  return BUSINESSES.map((b) => ({
    id: b.id,
    name: b.name,
    shortName: b.shortName,
    kind: b.kind,
    tagline: b.tagline,
    description: b.description,
    timezone: b.timezone,
  }));
}

/** Public profile (no notify email/phone). Null for an unknown id. */
export async function getBusinessProfile(
  businessId: string,
): Promise<PublicBusinessProfile | null> {
  const b = BUSINESSES.find((x) => x.id === businessId);
  if (!b) return null;
  return {
    id: b.id,
    name: b.name,
    shortName: b.shortName,
    kind: b.kind,
    tagline: b.tagline,
    description: b.description,
    timezone: b.timezone,
    supportEmail: b.supportEmail,
    escalationResponse: b.escalationResponse,
    serviceArea:
      b.serviceArea.mode === "any"
        ? { mode: "any" }
        : { mode: "zipPrefixes", prefixes: [...b.serviceArea.prefixes] },
    supportHours: hoursView(b.supportHours),
    bookingHours: hoursView(b.bookingHours),
    policyKeys: b.policies.map((p) => p.key),
  };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

type ProductRow = {
  sku: string;
  name: string;
  category: string;
  description: string;
  priceCents: number;
  unit: string;
  weightLb: number;
  qtyOnHand: number;
};

export function toProductSummary(p: ProductRow): ProductSummary {
  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    description: p.description,
    priceCents: p.priceCents,
    unit: p.unit,
    weightLb: p.weightLb,
    qtyOnHand: Math.max(0, p.qtyOnHand),
    inStock: p.qtyOnHand > 0,
  };
}

const STOPWORDS = new Set(
  "a an and the for of in on to with i need want some any do you have is are my me what".split(" "),
);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/.]+/g, " ");

function tokens(q: string): string[] {
  return norm(q)
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** Fuzzy-ish relevance: name/SKU hits weigh more than category/description hits. */
export function scoreProduct(p: ProductRow, toks: readonly string[]): number {
  const name = norm(p.name);
  const sku = p.sku.toLowerCase();
  const cat = norm(p.category);
  const desc = norm(p.description);
  let score = 0;
  for (const t of toks) {
    if (sku.includes(t)) score += 4;
    else if (name.includes(t)) score += 3;
    else if (cat.includes(t)) score += 2;
    else if (desc.includes(t)) score += 1;
  }
  return score;
}

export type SearchCatalogResult = Out<typeof SearchCatalogOutput>;

/**
 * Product sellers: products matching name/SKU/category/description (with stock status).
 * Service businesses: `results` is empty and `services` lists the services that match.
 */
export async function searchCatalog(
  businessId: string,
  opts: { query?: string; category?: string; limit?: number } = {},
): Promise<SearchCatalogResult> {
  const business = requireBusiness(businessId);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const toks = tokens(opts.query ?? "");

  if (business.kind === "service") {
    const services = servicesForBusiness(businessId)
      .map((s) => ({
        s,
        score: toks.length === 0 ? 1 : scoreProduct(asRow(s), toks),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ s }) => ({
        code: s.code,
        name: s.name,
        description: s.description,
        fromPriceCents: Math.min(...s.tiers.map((t) => t.priceCents)),
      }));
    return { results: [], total: services.length, categories: [], services };
  }

  const rows = await db().product.findMany({
    where: { businessId, active: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  const categories = [...new Set(rows.map((r) => r.category))];
  const cat = opts.category?.trim().toLowerCase();
  let matches = rows
    .filter((r) => !cat || r.category.toLowerCase().includes(cat))
    .map((r) => ({ r, score: toks.length === 0 ? 1 : scoreProduct(r, toks) }))
    .filter((x) => x.score > 0);
  if (toks.length > 1) {
    // Prefer products that match most of the words; keep partial matches only as a fallback.
    const best = Math.max(0, ...matches.map((m) => m.score));
    matches = matches.filter((m) => m.score >= Math.min(best, toks.length));
  }
  matches.sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name));
  return {
    results: matches.slice(0, limit).map((m) => toProductSummary(m.r)),
    total: matches.length,
    categories,
  };
}

function asRow(s: { code: string; name: string; description: string }): ProductRow {
  return {
    sku: s.code,
    name: s.name,
    category: "",
    description: s.description,
    priceCents: 0,
    unit: "",
    weightLb: 0,
    qtyOnHand: 0,
  };
}

export async function getProduct(
  businessId: string,
  sku: string,
): Promise<Out<typeof GetProductOutput>> {
  requireBusiness(businessId);
  const key = sku.trim().toUpperCase();
  const p = await db().product.findFirst({ where: { businessId, sku: key, active: true } });
  if (!p) {
    return { notFound: true, sku: key, message: `No product with SKU ${key} in this catalog.` };
  }
  return { product: toProductSummary(p) };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export async function listServices(businessId: string): Promise<Out<typeof ListServicesOutput>> {
  requireBusiness(businessId);
  return {
    services: servicesForBusiness(businessId).map((s) => ({
      code: s.code,
      name: s.name,
      description: s.description,
      includes: [...s.includes],
      tiers: s.tiers.map((t) => ({
        code: t.code,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        durationMin: t.durationMin,
        extraUnit: t.extraUnit ? { ...t.extraUnit } : undefined,
      })),
      addOns: s.addOns.map((a) => ({
        code: a.code,
        name: a.name,
        description: a.includedInTiers?.length
          ? `${a.description} (included in tiers ${a.includedInTiers.join(", ")})`
          : a.description,
        priceCents: a.priceCents,
        minutes: a.minutes,
        taxable: a.taxable,
        maxQty: a.maxQty,
      })),
      surcharges: s.surcharges.map((x) => ({
        code: x.code,
        name: x.name,
        condition: x.condition,
        price: surchargePriceLabel(x),
        minutes: x.minutes,
        explanation: x.explanation,
      })),
      frequencies: (
        s.frequencies ?? [{ code: "one_time", name: "One-time", discountPercent: 0 }]
      ).map((f) => ({ code: f.code, name: f.name, discountPercent: f.discountPercent })),
      notes: [...(s.notes ?? [])],
    })),
  };
}

export type ServiceQuoteResult =
  | (Extract<Out<typeof QuoteServiceOutput>, { quote: unknown }> & {
      tierName: string;
      laborCents: number;
      materialsCents: number;
      durationMin: number;
    })
  | { notFound: true; message: string }
  | { invalid: true; message: string; errors: { field: string; message: string }[] };

/**
 * Quote one service selection: itemized lines (each surcharge line carries its "why"),
 * labor vs taxable materials, tax, total and on-site duration. Never throws on bad input.
 */
export async function quoteService(
  businessId: string,
  selection: z.input<typeof ServiceConfig>,
): Promise<ServiceQuoteResult> {
  requireBusiness(businessId);
  const parsed = ServiceConfig.safeParse(selection);
  if (!parsed.success) {
    return {
      invalid: true,
      message: "The service selection is incomplete or malformed.",
      errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    };
  }
  const def = getServiceDefinition(businessId, parsed.data.serviceCode);
  if (!def) {
    const codes = servicesForBusiness(businessId).map((s) => s.code);
    return {
      notFound: true,
      message: `No service "${parsed.data.serviceCode}" here. Services: ${codes.join(", ") || "none"}.`,
    };
  }
  const r = priceService(def, parsed.data);
  if (!r.ok) {
    return {
      invalid: true,
      message: r.errors.map((e) => e.message).join(" "),
      errors: r.errors,
    };
  }
  const durationMin = r.quote.durationMin ?? 0;
  const estimate = requiresOnSiteEstimate(businessId, durationMin);
  return {
    serviceCode: def.code,
    tierCode: parsed.data.tierCode.toUpperCase(),
    tierName: r.tierName,
    quote: r.quote,
    laborCents: r.laborCents,
    materialsCents: r.materialsCents,
    durationMin,
    surchargeExplanations: r.surchargeExplanations,
    warnings: r.warnings,
    // EDGE-2: longer than one business day → cannot be booked online.
    ...(estimate
      ? {
          requiresOnSiteEstimate: true,
          onSiteEstimateReason: onSiteEstimateReason(businessId, durationMin),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Policies + service area
// ---------------------------------------------------------------------------

/** Policies from config; for service businesses also every surcharge's explanation. */
export async function getPolicies(
  businessId: string,
  topic?: string,
): Promise<Out<typeof GetPoliciesOutput>> {
  const b = requireBusiness(businessId);
  const all = [...b.policies.map((p) => ({ key: p.key, title: p.title, text: p.text }))];
  for (const s of servicesForBusiness(businessId)) {
    for (const x of s.surcharges) {
      all.push({
        key: `surcharge:${x.code}`,
        title: `${s.name}: ${x.name} (${surchargePriceLabel(x)})`,
        text: `${x.condition} ${x.explanation}`,
      });
    }
  }
  const t = topic?.trim().toLowerCase();
  let policies = all;
  if (t) {
    const hits = all.filter(
      (p) =>
        p.key.toLowerCase().includes(t) ||
        p.title.toLowerCase().includes(t) ||
        p.text.toLowerCase().includes(t),
    );
    policies = hits.length > 0 ? hits : all;
  }
  return { businessName: b.name, policies, hours: hoursView(b.supportHours) };
}

export async function checkServiceArea(
  businessId: string,
  zip: string,
): Promise<Out<typeof CheckServiceAreaOutput>> {
  const b = requireBusiness(businessId);
  const z = zip.trim();
  if (!/^\d{5}(-\d{4})?$/.test(z)) {
    return { zip: z, served: false, message: "That is not a valid 5-digit US ZIP code." };
  }
  if (b.kind === "product") {
    return {
      zip: z,
      served: true,
      message: `${b.shortName} ships to every US ZIP, including ${z}.`,
    };
  }
  if (b.serviceArea.mode === "any") {
    return { zip: z, served: true, message: `${b.shortName} serves ZIP ${z}.` };
  }
  const served = zipInServiceArea(b.serviceArea, z);
  return {
    zip: z,
    served,
    message: served
      ? `${b.shortName} serves ZIP ${z}.`
      : `Sorry, ${b.shortName} does not serve ZIP ${z} yet.`,
  };
}

/** Pure service-area rule: "any" accepts every ZIP; "zipPrefixes" only listed prefixes. */
export function zipInServiceArea(area: ServiceArea, zip: string): boolean {
  if (area.mode === "any") return true;
  return area.prefixes.some((p) => zip.trim().startsWith(p));
}

/** Same rule as checkServiceArea, synchronous, for checkout. */
export function isZipServed(businessId: string, zip: string): boolean {
  const b = requireBusiness(businessId);
  return b.kind === "product" || zipInServiceArea(b.serviceArea, zip);
}
