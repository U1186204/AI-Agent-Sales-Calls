/**
 * Ground shipping engine (SPEC §6, config SHIPPING_RULES). Pure — no DB.
 *
 * 1. billableLb = max(1, ceil(total weight)) — weights summed in milli-pounds to avoid float drift.
 * 2. transport = zoneBase + perLb × billableLb.
 * 3. + $25 handling for EACH unit over 50 lb.
 * 4. Goods subtotal ≥ $249 → free transport, except heavy units still pay
 *    zoneBase + perLb × max(1, ceil(heavy weight)) plus their handling.
 */
import {
  SHIPPING_RULES,
  shippingZoneForZip,
  ZONE_RATES,
  ZONE_TRANSIT_DAYS,
  type ShipZone,
} from "@/config/pricing";

export interface ShipItem {
  weightLb: number;
  qty: number;
}

export interface ShippingQuote {
  zip: string;
  zone: ShipZone;
  region: string;
  billableLb: number;
  heavyUnits: number;
  /** Transport charge (base + per-lb) after any free-shipping offer. */
  transportCents: number;
  handlingCents: number;
  /** transport + handling. */
  totalCents: number;
  freeShippingApplied: boolean;
  transitDays: { min: number; max: number };
  notes: string[];
}

const milli = (lb: number) => Math.round(lb * 1000);
const ceilLb = (milliLb: number) =>
  Math.max(SHIPPING_RULES.MIN_BILLABLE_LB, Math.ceil(milliLb / 1000));

export function quoteShipping(
  items: readonly ShipItem[],
  goodsSubtotalCents: number,
  zip: string,
): ShippingQuote | null {
  const z = shippingZoneForZip(zip);
  if (!z) return null;
  const rate = ZONE_RATES[z.zone];

  let totalMilli = 0;
  let heavyMilli = 0;
  let heavyUnits = 0;
  for (const it of items) {
    if (it.qty <= 0) continue;
    totalMilli += milli(it.weightLb) * it.qty;
    if (it.weightLb > SHIPPING_RULES.HEAVY_ITEM_LB) {
      heavyUnits += it.qty;
      heavyMilli += milli(it.weightLb) * it.qty;
    }
  }

  const billableLb = ceilLb(totalMilli);
  const handlingCents = heavyUnits * SHIPPING_RULES.HEAVY_HANDLING_CENTS;
  const free = goodsSubtotalCents >= SHIPPING_RULES.FREE_SHIPPING_THRESHOLD_CENTS;
  const notes: string[] = [];

  let transportCents: number;
  if (!free) {
    transportCents = rate.baseCents + rate.perLbCents * billableLb;
  } else if (heavyUnits === 0) {
    transportCents = 0;
    notes.push(SHIPPING_RULES.explanation.free);
  } else {
    transportCents = rate.baseCents + rate.perLbCents * ceilLb(heavyMilli);
    notes.push(SHIPPING_RULES.explanation.free);
  }
  if (heavyUnits > 0) notes.push(SHIPPING_RULES.explanation.heavy);

  return {
    zip: zip.trim(),
    zone: z.zone,
    region: z.region,
    billableLb,
    heavyUnits,
    transportCents,
    handlingCents,
    totalCents: transportCents + handlingCents,
    freeShippingApplied: free,
    transitDays: ZONE_TRANSIT_DAYS[z.zone],
    notes,
  };
}
