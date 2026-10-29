/**
 * THE single source of money rules for Oasis (SPEC §6). Values come from
 * docs/research/pricing.md. All money is integer US cents. Durations are minutes.
 *
 * This file is DATA plus a few tiny pure lookups. The pricing engine that combines these
 * numbers lives in src/domain (it must import everything from here, never hard-code).
 *
 * Demo data only — not quotes from any real company.
 */

// ---------------------------------------------------------------------------
// Tax (demo rule)
// ---------------------------------------------------------------------------

/**
 * Flat demo tax rate in basis points (750 = 7.5%).
 * Taxed: catalog goods, and service add-ons flagged `taxable` (materials the customer keeps).
 * Not taxed: labor (service tiers, labor add-ons), surcharges, shipping.
 * Discounts reduce the line they apply to BEFORE tax.
 * tax = roundHalfUp(sum(taxable amounts after discounts) * TAX_RATE_BPS / 10_000), computed once
 * per order on the taxable subtotal (not per line).
 */
export const TAX_RATE_BPS = 750;
export const TAX_RATE = TAX_RATE_BPS / 10_000;

export const TAX_DISCLAIMER =
  "Demo tax: 7.5% on goods and materials; labor and shipping untaxed. Real tax depends on your location. Demo tax rule — not tax advice.";

/** Integer half-up rounding of `cents * bps / 10_000` (exact for non-negative integers). */
export function applyBps(cents: number, bps: number): number {
  return Math.floor((cents * bps + 5_000) / 10_000);
}

/** Integer half-up rounding of `cents * percent / 100`. */
export function applyPercent(cents: number, percent: number): number {
  return applyBps(cents, Math.round(percent * 100));
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Shipping (product businesses)
// ---------------------------------------------------------------------------

/** Demo warehouse for both product businesses: Indianapolis, IN. */
export const SHIPPING_ORIGIN = { zip: "46241", city: "Indianapolis", state: "IN" } as const;

export type ShipZone = 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Ground rate table: cost = baseCents + perLbCents × billableLb. */
export const ZONE_RATES: Record<ShipZone, { baseCents: number; perLbCents: number }> = {
  2: { baseCents: 850, perLbCents: 45 },
  3: { baseCents: 900, perLbCents: 55 },
  4: { baseCents: 975, perLbCents: 70 },
  5: { baseCents: 1050, perLbCents: 90 },
  6: { baseCents: 1125, perLbCents: 110 },
  7: { baseCents: 1200, perLbCents: 130 },
  8: { baseCents: 1275, perLbCents: 155 },
};

/** Estimated ground transit time (business days) by zone, for delivery-time answers. */
export const ZONE_TRANSIT_DAYS: Record<ShipZone, { min: number; max: number }> = {
  2: { min: 1, max: 2 },
  3: { min: 2, max: 2 },
  4: { min: 2, max: 3 },
  5: { min: 3, max: 4 },
  6: { min: 4, max: 4 },
  7: { min: 4, max: 5 },
  8: { min: 5, max: 7 },
};

/**
 * Destination zone rules, evaluated top to bottom against the destination ZIP (first match
 * wins). SPEC §6: every valid US ZIP ships ("no region lock"), so — unlike the research
 * table, which excluded them — Alaska, Hawaii, Puerto Rico and other territories are served
 * at zone 8 rates (a demo simplification). Zone 6 exists in the rate table but no prefix maps
 * to it with the Indianapolis origin.
 */
export const ZONE_RULES: ReadonlyArray<{
  prefixes: readonly string[];
  zone: ShipZone;
  region: string;
}> = [
  { prefixes: ["46", "47"], zone: 2, region: "Indiana" },
  { prefixes: ["006", "007", "008", "009"], zone: 8, region: "Puerto Rico / US Virgin Islands" },
  { prefixes: ["967", "968", "969"], zone: 8, region: "Hawaii / Pacific territories" },
  { prefixes: ["995", "996", "997", "998", "999"], zone: 8, region: "Alaska" },
  { prefixes: ["32", "33", "34"], zone: 5, region: "Florida" },
  { prefixes: ["4"], zone: 3, region: "Ohio, Michigan, Kentucky" },
  { prefixes: ["6"], zone: 3, region: "Illinois, Missouri, Kansas, Nebraska" },
  { prefixes: ["1", "2"], zone: 4, region: "Mid-Atlantic and Carolinas" },
  { prefixes: ["3"], zone: 4, region: "Southeast" },
  { prefixes: ["0"], zone: 5, region: "New England and New Jersey" },
  { prefixes: ["5"], zone: 5, region: "Upper Midwest and Plains" },
  { prefixes: ["7"], zone: 5, region: "Texas, Oklahoma, Arkansas, Louisiana" },
  { prefixes: ["8"], zone: 7, region: "Mountain West" },
  { prefixes: ["9"], zone: 8, region: "West Coast" },
];

/** Zone for a 5-digit (or ZIP+4) US ZIP; null only for malformed input. */
export function shippingZoneForZip(zip: string): { zone: ShipZone; region: string } | null {
  const z = zip.trim();
  if (!/^\d{5}(-\d{4})?$/.test(z)) return null;
  for (const rule of ZONE_RULES) {
    if (rule.prefixes.some((p) => z.startsWith(p))) return { zone: rule.zone, region: rule.region };
  }
  return null;
}

/**
 * Shipping rules (domain/shipping implements them exactly):
 * 1. billableLb = max(MIN_BILLABLE_LB, ceil(total weight of all units)).
 * 2. cost = ZONE_RATES[zone].baseCents + perLbCents × billableLb.
 * 3. + HEAVY_HANDLING_CENTS for EACH UNIT whose weight is > HEAVY_ITEM_LB
 *    (e.g. 2 toilets = 2 × $25).
 * 4. Free shipping when goods subtotal (after discounts, before tax) ≥ FREE_SHIPPING_THRESHOLD_CENTS.
 *    Heavy units are excluded from the free offer: they still pay
 *    baseCents + perLbCents × max(1, ceil(heavy units' weight)) plus their handling fee;
 *    if there are no heavy units shipping is $0.
 * 5. Shipping is never taxed. Services never carry shipping.
 */
export const SHIPPING_RULES = {
  MIN_BILLABLE_LB: 1,
  HEAVY_ITEM_LB: 50,
  HEAVY_HANDLING_CENTS: 2500,
  FREE_SHIPPING_THRESHOLD_CENTS: 24_900,
  /** Single units above this ship as freight (quote required). None in the demo catalog. */
  FREIGHT_ITEM_LB: 150,
  carrierLabel: "Ground (demo rates)",
  explanation: {
    heavy:
      "Items over 50 lb (like toilets and water heaters) need two-person handling and special packaging, so each one carries a $25 handling fee and is not included in free shipping.",
    free: "Orders with a goods subtotal of $249 or more ship free by ground, except the weight share and handling for items over 50 lb.",
    zones:
      "Shipping is priced by distance from our Indianapolis warehouse (zone 2 nearby up to zone 8 for the West Coast, Alaska, Hawaii and territories) and by total weight, rounded up to the next pound.",
  },
} as const;

// ---------------------------------------------------------------------------
// Service catalogs (service businesses)
// ---------------------------------------------------------------------------

export interface ServiceTier {
  code: string;
  name: string;
  /** What qualifies for this tier, e.g. TV size or lot size. */
  description: string;
  priceCents: number;
  durationMin: number;
  /** Number of technicians/cleaners sent. Informational. */
  crew: number;
  /** Optional per-unit extension of the base (e.g. each additional acre). Part of "base". */
  extraUnit?: { name: string; priceCents: number; minutes: number; maxQty: number };
}

export interface ServiceAddOn {
  code: string;
  name: string;
  description: string;
  /** Price per unit (qty defaults to 1). */
  priceCents: number;
  /** Extra on-site minutes per unit. */
  minutes: number;
  /** True when the add-on is mainly hardware/materials the customer keeps (taxed at TAX_RATE). */
  taxable: boolean;
  /** Maximum quantity (1 = on/off toggle). */
  maxQty: number;
  unitLabel?: string;
  /** Add-ons sharing a group are mutually exclusive (e.g. one mount type). */
  exclusiveGroup?: string;
  /** Tier codes where this add-on is already included at no charge. */
  includedInTiers?: readonly string[];
}

export type SurchargeKind =
  /** Flat amount in cents. */
  | { type: "fixed"; cents: number }
  /** Percent of the base (tier price + extraUnit charges), rounded half-up. */
  | { type: "percent"; percent: number }
  /** cents × quantity, e.g. per square foot of excess area. */
  | { type: "perUnit"; centsPerUnit: number; unitLabel: string; maxQty: number };

export interface ServiceSurcharge {
  code: string;
  name: string;
  /** When it applies, phrased for the customer. */
  condition: string;
  kind: SurchargeKind;
  /** Extra on-site minutes. */
  minutes: number;
  /** WHY it costs more — the agent answers "why" questions from this text. */
  explanation: string;
  exclusiveGroup?: string;
  /** Price is an estimate the technician confirms on arrival. */
  confirmOnSite?: boolean;
}

export interface ServiceFrequency {
  code: "one_time" | "weekly" | "biweekly" | "monthly" | "seasonal_prepay";
  name: string;
  /** Percent off the base (tier price + extraUnit). Never off add-ons or surcharges. */
  discountPercent: number;
  note?: string;
}

export interface ServiceDefinition {
  code: string;
  businessId: string;
  name: string;
  description: string;
  includes: readonly string[];
  tiers: readonly ServiceTier[];
  addOns: readonly ServiceAddOn[];
  surcharges: readonly ServiceSurcharge[];
  /** Omitted = one-time only. */
  frequencies?: readonly ServiceFrequency[];
  notes?: readonly string[];
}

const ONE_TIME: ServiceFrequency = { code: "one_time", name: "One-time", discountPercent: 0 };

// ----- MountPro TV Installation ---------------------------------------------

const TV_MOUNTING: ServiceDefinition = {
  code: "tv-mounting",
  businessId: "mountpro-tv",
  name: "TV wall mounting",
  description:
    "Professional wall mounting of one TV on drywall at standard height using a customer-supplied mount, or add a mount from us.",
  includes: [
    "Stud location and level, secure mounting",
    "Hardware for drywall over wood studs",
    "Basic cable tidy and a test of the picture and inputs",
    "Clean-up of drilling dust",
  ],
  tiers: [
    {
      code: "S",
      name: 'Small (up to 42")',
      description: "TV up to 42 inches",
      priceCents: 9900,
      durationMin: 45,
      crew: 1,
    },
    {
      code: "M",
      name: 'Medium (43"–55")',
      description: "TV 43 to 55 inches",
      priceCents: 12900,
      durationMin: 60,
      crew: 1,
    },
    {
      code: "L",
      name: 'Large (56"–70")',
      description: "TV 56 to 70 inches",
      priceCents: 16900,
      durationMin: 75,
      crew: 1,
    },
    {
      code: "XL",
      name: 'Extra large (71"–85")',
      description: "TV 71 to 85 inches; two technicians",
      priceCents: 22900,
      durationMin: 90,
      crew: 2,
    },
    {
      code: "XXL",
      name: 'Oversize (86"+)',
      description: "TV 86 inches or larger; two technicians",
      priceCents: 29900,
      durationMin: 120,
      crew: 2,
    },
  ],
  addOns: [
    {
      code: "mount-fixed",
      name: "Fixed / low-profile mount supplied",
      description: "We bring a fixed low-profile mount sized for your TV.",
      priceCents: 4500,
      minutes: 0,
      taxable: true,
      maxQty: 1,
      exclusiveGroup: "mount",
    },
    {
      code: "mount-tilt",
      name: "Tilting mount supplied",
      description: "We bring a tilting mount sized for your TV.",
      priceCents: 6500,
      minutes: 0,
      taxable: true,
      maxQty: 1,
      exclusiveGroup: "mount",
    },
    {
      code: "mount-full-motion",
      name: "Full-motion mount supplied",
      description:
        "We bring an articulating full-motion mount; extra time to install and adjust the arm.",
      priceCents: 12900,
      minutes: 15,
      taxable: true,
      maxQty: 1,
      exclusiveGroup: "mount",
    },
    {
      code: "in-wall-concealment",
      name: "In-wall cable concealment",
      description: "Power kit plus HDMI routed inside the wall (drywall only).",
      priceCents: 14900,
      minutes: 45,
      taxable: true,
      maxQty: 1,
      exclusiveGroup: "cables",
    },
    {
      code: "on-wall-raceway",
      name: "On-wall cable raceway",
      description: "Paintable cover that hides cables on the wall surface.",
      priceCents: 4900,
      minutes: 15,
      taxable: true,
      maxQty: 1,
      exclusiveGroup: "cables",
    },
    {
      code: "soundbar-mount",
      name: "Soundbar mount",
      description: "Bracket supplied and soundbar installed below the TV.",
      priceCents: 7900,
      minutes: 20,
      taxable: true,
      maxQty: 1,
    },
    {
      code: "new-outlet",
      name: "New outlet behind TV",
      description: "New outlet installed behind the TV by a licensed electrician (labor).",
      priceCents: 19900,
      minutes: 45,
      // EDGE-8: priced as labor. docs/research/pricing.md lists this add-on at $199 with no
      // parts amount; its "outlet parts" tax row covers parts sold separately, so there is no
      // materials share to split out. A real deployment would add a taxable parts line.
      taxable: false,
      maxQty: 1,
    },
    {
      code: "device-shelf",
      name: "Floating device shelf",
      description: "Floating shelf supplied and installed for a streaming box or console.",
      priceCents: 5900,
      minutes: 20,
      taxable: true,
      maxQty: 2,
      unitLabel: "shelf",
    },
    {
      code: "unmount-old",
      name: "Remove old TV / mount",
      description: "Take down an existing TV and mount (labor).",
      priceCents: 4900,
      minutes: 20,
      taxable: false,
      maxQty: 1,
    },
  ],
  surcharges: [
    {
      code: "above-fireplace",
      name: "Above fireplace",
      condition: "The TV goes above a fireplace (drywall).",
      kind: { type: "fixed", cents: 10000 },
      minutes: 15,
      explanation:
        "Mounting above a fireplace takes longer and carries more risk. The installer works on a ladder at height, has to find studs around the chimney chase (often offset or blocked by framing), checks mantel clearance and heat exposure so the TV stays within its rated temperature, and runs cables a longer path. That extra time, equipment and care is why it costs $100 more.",
    },
    {
      code: "masonry-surface",
      name: "Brick, stone, concrete or tile",
      condition: "The wall surface is brick, stone, concrete or tile.",
      kind: { type: "fixed", cents: 9000 },
      minutes: 30,
      explanation:
        "Masonry and tile need a hammer drill, masonry bits and sleeve or wedge anchors instead of wood screws. Drilling is slower, tile has to be drilled carefully to avoid cracking, and the anchors cost more — that is why it adds $90.",
    },
    {
      code: "high-mount",
      name: "High mount",
      condition: "The bottom of the TV is over 6 ft high, or a ladder over 8 ft is needed.",
      kind: { type: "fixed", cents: 5000 },
      minutes: 15,
      explanation:
        "High mounts need a taller ladder and usually a second set of hands to lift and hold the TV safely at height, which adds time and risk — hence $50 more.",
    },
    {
      code: "metal-or-no-studs",
      name: "Metal studs or no studs",
      condition: "The wall has metal studs or no studs where the TV goes.",
      kind: { type: "fixed", cents: 3000 },
      minutes: 10,
      explanation:
        "Without wood studs the mount is hung with heavy-duty toggle anchors that spread the load across the drywall. They cost more than lag screws and take longer to place correctly, so there is a $30 surcharge.",
    },
  ],
  notes: [
    "A second technician is included in the XL and XXL tiers and for TVs over 80 lb.",
    'Example: 65" TV with a full-motion mount, in-wall concealment, above a brick fireplace = $169 + $129 + $149 + $100 + $90 = $637 before tax.',
  ],
};

// ----- GreenStripe Lawn Care -------------------------------------------------

const LAWN_MOWING: ServiceDefinition = {
  code: "lawn-mowing",
  businessId: "greenstripe-lawn",
  name: "Lawn mowing visit",
  description: "Mow, string-trim and blow off hard surfaces, priced by turf lot size.",
  includes: ["Mowing", "String trimming around obstacles", "Blowing driveway, walks and patio"],
  tiers: [
    {
      code: "XS",
      name: "Extra small (up to 1/8 acre)",
      description: "Up to about 5,400 sq ft of turf",
      priceCents: 4000,
      durationMin: 25,
      crew: 1,
    },
    {
      code: "S",
      name: "Small (up to 1/4 acre)",
      description: "Up to 1/4 acre of turf",
      priceCents: 5500,
      durationMin: 35,
      crew: 1,
    },
    {
      code: "M",
      name: "Medium (up to 1/2 acre)",
      description: "Up to 1/2 acre of turf",
      priceCents: 7500,
      durationMin: 50,
      crew: 1,
    },
    {
      code: "L",
      name: "Large (up to 1 acre)",
      description: "Up to 1 acre of turf (riding mower)",
      priceCents: 11000,
      durationMin: 80,
      crew: 1,
    },
    {
      code: "XL",
      name: "Extra large (over 1 acre)",
      description: "Over 1 acre: the 1-acre price plus $60 for each additional acre",
      priceCents: 11000,
      durationMin: 80,
      crew: 1,
      extraUnit: { name: "additional acre", priceCents: 6000, minutes: 45, maxQty: 9 },
    },
  ],
  addOns: [
    {
      code: "edging",
      name: "Edging",
      description: "Crisp edges along sidewalk, driveway and beds.",
      priceCents: 1500,
      minutes: 10,
      taxable: false,
      maxQty: 1,
    },
    {
      code: "detail-trim",
      name: "Extra detail trimming",
      description: "Fences, many beds, or lots of obstacles.",
      priceCents: 1500,
      minutes: 10,
      taxable: false,
      maxQty: 1,
    },
    {
      code: "leaf-cleanup",
      name: "Leaf blowing / light leaf cleanup",
      description: "Light leaf cleanup of lawn and beds (not full leaf removal).",
      priceCents: 3500,
      minutes: 20,
      taxable: false,
      maxQty: 1,
    },
    {
      code: "bag-haul",
      name: "Bagging and haul-away",
      description: "Clippings bagged and hauled away.",
      priceCents: 2000,
      minutes: 10,
      taxable: false,
      maxQty: 1,
    },
    {
      code: "weed-pulling",
      name: "Weed pulling in beds",
      description: "Hand weeding, per 30 minutes.",
      priceCents: 3000,
      minutes: 30,
      taxable: false,
      maxQty: 4,
      unitLabel: "30 min",
    },
    {
      code: "shrub-trim",
      name: "Shrub trimming (up to 5 shrubs)",
      description: "Shape and trim up to 5 shrubs.",
      priceCents: 4500,
      minutes: 25,
      taxable: false,
      maxQty: 2,
      unitLabel: "5 shrubs",
    },
  ],
  surcharges: [
    {
      code: "overgrown",
      name: "Overgrown (6–12 in)",
      condition: "Grass is 6 to 12 inches tall (typical first cut of the season).",
      kind: { type: "percent", percent: 50 },
      minutes: 20,
      exclusiveGroup: "growth",
      explanation:
        "Tall grass has to be cut in two passes at different heights so the mower does not clog or scalp the lawn, and there are far more clippings to clear. That roughly adds half again the time, so it is +50% of the base price.",
    },
    {
      code: "severely-overgrown",
      name: "Severely overgrown (over 12 in)",
      condition: "Grass or weeds are over 12 inches tall.",
      kind: { type: "percent", percent: 100 },
      minutes: 40,
      exclusiveGroup: "growth",
      confirmOnSite: true,
      explanation:
        "Very tall growth usually needs a brush cutter or string trimmer first, then multiple mower passes, plus hauling much more debris. It roughly doubles the work, so it is +100% of the base price, and the crew confirms the price on arrival.",
    },
    {
      code: "steep-slope",
      name: "Steep slope / hillside",
      condition: "Part of the lawn is steeper than about 15 degrees.",
      kind: { type: "percent", percent: 25 },
      minutes: 10,
      explanation:
        "Slopes over about 15 degrees cannot be mowed safely with a riding mower and must be done with a walk-behind or by trimming across the slope. It is slower and more strenuous, so slopes add 25% of the base price.",
    },
    {
      code: "gated-pet-waste",
      name: "Gated yard / pet waste cleanup",
      condition: "The yard is gated and needs pet waste picked up before mowing.",
      kind: { type: "fixed", cents: 1500 },
      minutes: 10,
      explanation:
        "Pet waste has to be picked up before mowing so it is not spread across the lawn or onto equipment, which takes extra time and disposal — that is the $15.",
    },
  ],
  frequencies: [
    ONE_TIME,
    { code: "biweekly", name: "Every 2 weeks", discountPercent: 5 },
    { code: "weekly", name: "Weekly", discountPercent: 10 },
    {
      code: "seasonal_prepay",
      name: "Seasonal prepay (weekly, 28 visits)",
      discountPercent: 15,
      note: "Prepaid season of 28 weekly visits.",
    },
  ],
  notes: ["Recurring discounts apply to the base visit price only, not add-ons or surcharges."],
};

// ----- BrightNest House Cleaning -----------------------------------------------

type CleanKind = "standard" | "deep" | "move";

const BEDROOM_TIERS: ReadonlyArray<{
  code: string;
  name: string;
  price: Record<CleanKind, number>;
  minutes: { standard: number; deepMove: number };
}> = [
  {
    code: "1BR",
    name: "Studio / 1 bedroom",
    price: { standard: 11000, deep: 19000, move: 23000 },
    minutes: { standard: 90, deepMove: 180 },
  },
  {
    code: "2BR",
    name: "2 bedrooms",
    price: { standard: 14000, deep: 25000, move: 30000 },
    minutes: { standard: 120, deepMove: 240 },
  },
  {
    code: "3BR",
    name: "3 bedrooms",
    price: { standard: 18000, deep: 33000, move: 39000 },
    minutes: { standard: 150, deepMove: 300 },
  },
  {
    code: "4BR",
    name: "4 bedrooms",
    price: { standard: 23000, deep: 42000, move: 49000 },
    minutes: { standard: 180, deepMove: 360 },
  },
  {
    code: "5BR",
    name: "5+ bedrooms",
    price: { standard: 28000, deep: 52000, move: 60000 },
    minutes: { standard: 210, deepMove: 420 },
  },
];

const EXTRA_BATH: Record<CleanKind, { full: number; half: number; minutes: number }> = {
  // Assumption (not in research): +20 min per extra full bath standard, +30 deep/move.
  standard: { full: 2500, half: 1250, minutes: 20 },
  deep: { full: 4500, half: 2250, minutes: 30 },
  move: { full: 5000, half: 2500, minutes: 30 },
};

const SQFT_EXCESS_CENTS: Record<CleanKind, number> = { standard: 8, deep: 12, move: 12 };

function cleaningService(kind: CleanKind): ServiceDefinition {
  const names: Record<CleanKind, { code: string; name: string; description: string }> = {
    standard: {
      code: "standard-clean",
      name: "Standard house cleaning",
      description:
        "Recurring-style clean of kitchen, bathrooms, bedrooms and living areas. Two cleaners.",
    },
    deep: {
      code: "deep-clean",
      name: "Deep cleaning",
      description:
        "Top-to-bottom detail clean including baseboards, door frames, built-up grime. Two cleaners.",
    },
    move: {
      code: "move-clean",
      name: "Move-in / move-out cleaning",
      description:
        "Deep clean of an empty home: every room, closets, baseboards and appliance exteriors, ready for the next occupant. Two cleaners.",
    },
  };
  const meta = names[kind];
  const bath = EXTRA_BATH[kind];
  return {
    code: meta.code,
    businessId: "brightnest-cleaning",
    name: meta.name,
    description: meta.description,
    includes:
      kind === "standard"
        ? [
            "Dusting reachable surfaces",
            "Kitchen counters, sink, appliance exteriors",
            "Bathrooms sanitized",
            "Vacuum and mop floors",
            "Base price includes 1 bathroom",
          ]
        : [
            "Everything in a standard clean",
            "Baseboards, door frames and switch plates",
            "Detailed bathroom descaling",
            "Base price includes 1 bathroom",
          ],
    tiers: BEDROOM_TIERS.map((t) => ({
      code: t.code,
      name: t.name,
      description: `${t.name}, 1 bathroom included`,
      priceCents: t.price[kind],
      durationMin: kind === "standard" ? t.minutes.standard : t.minutes.deepMove,
      crew: 2,
    })),
    addOns: [
      {
        code: "extra-bathroom",
        name: "Additional full bathroom",
        description: "Each full bathroom beyond the first.",
        priceCents: bath.full,
        minutes: bath.minutes,
        taxable: false,
        maxQty: 5,
        unitLabel: "bathroom",
      },
      {
        code: "extra-half-bath",
        name: "Additional half bathroom",
        description: "Each half bath (toilet + sink), half price.",
        priceCents: bath.half,
        minutes: Math.round(bath.minutes / 2),
        taxable: false,
        maxQty: 4,
        unitLabel: "half bath",
      },
      {
        code: "inside-oven",
        name: "Inside oven",
        description: "Degrease and clean the oven interior.",
        priceCents: 3500,
        minutes: 30,
        taxable: false,
        maxQty: 1,
      },
      {
        code: "inside-fridge",
        name: "Inside fridge",
        description: "Empty-shelf wipe-down of the fridge interior.",
        priceCents: 3500,
        minutes: 30,
        taxable: false,
        maxQty: 1,
      },
      {
        code: "inside-cabinets",
        name: "Inside cabinets (empty, kitchen)",
        description: "Wipe the inside of empty kitchen cabinets.",
        priceCents: 4500,
        minutes: 45,
        taxable: false,
        maxQty: 1,
      },
      {
        code: "interior-windows",
        name: "Interior windows (per 10 panes)",
        description: "Inside glass, sills and tracks, per 10 panes.",
        priceCents: 4000,
        minutes: 30,
        taxable: false,
        maxQty: 6,
        unitLabel: "10 panes",
      },
      {
        code: "laundry",
        name: "Laundry (per load)",
        description: "Wash, dry and fold, per load.",
        priceCents: 2000,
        minutes: 15,
        taxable: false,
        maxQty: 4,
        unitLabel: "load",
      },
      {
        code: "pet-hair",
        name: "Pet hair treatment (per pet)",
        description: "Extra vacuuming and lint removal for shedding pets.",
        priceCents: 1500,
        minutes: 15,
        taxable: false,
        maxQty: 3,
        unitLabel: "pet",
      },
      {
        code: "baseboards",
        name: "Baseboards detail",
        description: "Hand-wipe all baseboards.",
        priceCents: 3000,
        minutes: 30,
        taxable: false,
        maxQty: 1,
        // Included in deep and move cleans (offered only as an add-on to standard).
        includedInTiers: kind === "standard" ? [] : BEDROOM_TIERS.map((t) => t.code),
      },
    ],
    surcharges: [
      {
        code: "large-home-sqft",
        name: "Large home (square footage over 600 per bedroom)",
        condition: "The home is larger than 600 sq ft per bedroom; charged per excess sq ft.",
        kind: {
          type: "perUnit",
          centsPerUnit: SQFT_EXCESS_CENTS[kind],
          unitLabel: "sq ft over 600 per bedroom",
          maxQty: 10_000,
        },
        minutes: 0,
        explanation: `Our bedroom pricing assumes about 600 sq ft per bedroom. Bigger rooms mean more floor, surfaces and fixtures to clean, so each extra square foot adds ${SQFT_EXCESS_CENTS[kind]} cents — that keeps the price fair compared with per-square-foot market rates.`,
      },
    ],
    frequencies:
      kind === "standard"
        ? [
            ONE_TIME,
            { code: "monthly", name: "Monthly", discountPercent: 5 },
            { code: "biweekly", name: "Every 2 weeks", discountPercent: 10 },
            { code: "weekly", name: "Weekly", discountPercent: 15 },
          ]
        : [ONE_TIME],
    notes:
      kind === "standard"
        ? [
            "Recurring discounts apply to standard cleans only, on the base price.",
            "A first-visit deep clean is often required before recurring service starts if the home has not been professionally cleaned recently.",
          ]
        : ["Deep and move cleans are one-time services; baseboards are included."],
  };
}

export const SERVICE_CATALOG: readonly ServiceDefinition[] = [
  TV_MOUNTING,
  LAWN_MOWING,
  cleaningService("standard"),
  cleaningService("deep"),
  cleaningService("move"),
];

export function getServiceDefinition(
  businessId: string,
  code: string,
): ServiceDefinition | undefined {
  return SERVICE_CATALOG.find((s) => s.businessId === businessId && s.code === code);
}

export function servicesForBusiness(businessId: string): ServiceDefinition[] {
  return SERVICE_CATALOG.filter((s) => s.businessId === businessId);
}
