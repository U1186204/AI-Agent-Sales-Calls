/**
 * Demo tax rule (SPEC §6): flat TAX_RATE_BPS on goods + materials, computed ONCE on the
 * taxable subtotal (after discounts), rounded half-up to the cent. Labor, labor surcharges
 * and shipping are never taxed. Pure.
 */
import { applyBps, TAX_DISCLAIMER, TAX_RATE_BPS } from "@/config/pricing";

export { TAX_DISCLAIMER, TAX_RATE_BPS };

export function computeTax(taxableCents: number, rateBps: number = TAX_RATE_BPS): number {
  return taxableCents <= 0 ? 0 : applyBps(taxableCents, rateBps);
}
