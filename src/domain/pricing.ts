/**
 * Pricing engine (SPEC §6). PURE functions over config + plain inputs; no DB, no env.
 * Every number comes from src/config/pricing.ts. All money is integer cents.
 */
import type { Quote, QuoteLine, ServiceConfig } from "@/contracts";
import {
  applyPercent,
  formatUsd,
  type ServiceAddOn,
  type ServiceDefinition,
  type ServiceSurcharge,
} from "@/config/pricing";
import { quoteShipping, type ShippingQuote } from "./shipping";
import { computeTax, TAX_DISCLAIMER, TAX_RATE_BPS } from "./tax";

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface PricedItem {
  sku: string;
  name: string;
  unit: string;
  priceCents: number;
  weightLb: number;
  qty: number;
}

export interface ProductPricing {
  quote: Quote;
  shipping: ShippingQuote | null;
}

/** Price goods (+ shipping when a valid ZIP is given). Items with qty 0 are skipped. */
export function priceProducts(items: readonly PricedItem[], zip?: string): ProductPricing {
  const priced = items.filter((i) => i.qty > 0);
  const lines: QuoteLine[] = priced.map((i) => ({
    kind: "goods",
    code: i.sku,
    label: i.name,
    qty: i.qty,
    unitCents: i.priceCents,
    amountCents: i.priceCents * i.qty,
    taxable: true,
  }));
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const notes: string[] = [];

  let shipping: ShippingQuote | null = null;
  if (zip !== undefined && zip.trim() !== "") {
    shipping = quoteShipping(priced, subtotalCents, zip);
    if (!shipping) notes.push("Enter a valid 5-digit US ZIP to price shipping.");
  } else {
    notes.push("Shipping is calculated once a destination ZIP is known.");
  }
  if (shipping) {
    lines.push({
      kind: "shipping",
      code: "shipping",
      label: `Ground shipping to ${shipping.zip} (zone ${shipping.zone}, ${shipping.billableLb} lb)`,
      qty: 1,
      unitCents: shipping.transportCents,
      amountCents: shipping.transportCents,
      taxable: false,
      note: shipping.freeShippingApplied ? "Free shipping applied" : undefined,
    });
    if (shipping.heavyUnits > 0) {
      lines.push({
        kind: "handling",
        code: "heavy-handling",
        label: "Heavy-item handling (over 50 lb)",
        qty: shipping.heavyUnits,
        unitCents: shipping.handlingCents / shipping.heavyUnits,
        amountCents: shipping.handlingCents,
        taxable: false,
      });
    }
    notes.push(...shipping.notes);
  }

  const taxableCents = subtotalCents;
  const taxCents = computeTax(taxableCents);
  const shippingCents = shipping?.totalCents ?? 0;
  return {
    shipping,
    quote: {
      currency: "USD",
      lines,
      subtotalCents,
      discountCents: 0,
      shippingCents,
      taxableCents,
      taxRateBps: TAX_RATE_BPS,
      taxCents,
      totalCents: subtotalCents + shippingCents + taxCents,
      shipZone: shipping?.zone,
      shipZip: shipping?.zip,
      notes,
      taxDisclaimer: TAX_DISCLAIMER,
    },
  };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface PricingIssue {
  field: string;
  message: string;
}

export type ServicePricing =
  | {
      ok: true;
      quote: Quote;
      tierName: string;
      /** Labor (untaxed) vs materials (taxed) split, after discounts. */
      laborCents: number;
      materialsCents: number;
      surchargeExplanations: { code: string; explanation: string }[];
      warnings: string[];
    }
  | { ok: false; errors: PricingIssue[] };

export function surchargePriceLabel(s: ServiceSurcharge): string {
  switch (s.kind.type) {
    case "fixed":
      return `+${formatUsd(s.kind.cents)}`;
    case "percent":
      return `+${s.kind.percent}% of base`;
    case "perUnit":
      return `+${formatUsd(s.kind.centsPerUnit)} per ${s.kind.unitLabel}`;
  }
}

/** Price one service configuration. Validation problems come back as `{ok:false, errors}`. */
export function priceService(def: ServiceDefinition, input: ServiceConfig): ServicePricing {
  const errors: PricingIssue[] = [];
  const tier = def.tiers.find((t) => t.code.toLowerCase() === input.tierCode.toLowerCase());
  if (!tier) {
    return {
      ok: false,
      errors: [
        {
          field: "tierCode",
          message: `Unknown tier "${input.tierCode}" for ${def.name}. Options: ${def.tiers.map((t) => t.code).join(", ")}.`,
        },
      ],
    };
  }

  const lines: QuoteLine[] = [
    {
      kind: "service",
      code: tier.code,
      label: `${def.name} — ${tier.name}`,
      qty: 1,
      unitCents: tier.priceCents,
      amountCents: tier.priceCents,
      taxable: false,
      minutes: tier.durationMin,
      note: "Labor",
    },
  ];
  let baseCents = tier.priceCents;
  let minutes = tier.durationMin;

  const extra = input.extraUnits ?? 0;
  if (extra > 0) {
    if (!tier.extraUnit) {
      errors.push({ field: "extraUnits", message: `The ${tier.name} tier has no extra units.` });
    } else if (extra > tier.extraUnit.maxQty) {
      errors.push({
        field: "extraUnits",
        message: `At most ${tier.extraUnit.maxQty} × ${tier.extraUnit.name}.`,
      });
    } else {
      const amt = tier.extraUnit.priceCents * extra;
      lines.push({
        kind: "extra_unit",
        code: `${tier.code}-extra`,
        label: `${tier.extraUnit.name} × ${extra}`,
        qty: extra,
        unitCents: tier.extraUnit.priceCents,
        amountCents: amt,
        taxable: false,
        minutes: tier.extraUnit.minutes * extra,
        note: "Labor",
      });
      baseCents += amt;
      minutes += tier.extraUnit.minutes * extra;
    }
  }

  // ----- add-ons ---------------------------------------------------------------
  const groups = new Map<string, string>();
  const seenAddOns = new Set<string>();
  for (const sel of input.addOns ?? []) {
    const a: ServiceAddOn | undefined = def.addOns.find((x) => x.code === sel.code);
    const qty = sel.qty ?? 1;
    if (!a) {
      errors.push({
        field: `addOns.${sel.code}`,
        message: `Unknown add-on "${sel.code}". Options: ${def.addOns.map((x) => x.code).join(", ")}.`,
      });
      continue;
    }
    if (seenAddOns.has(a.code)) {
      errors.push({ field: `addOns.${a.code}`, message: `${a.name} is listed twice.` });
      continue;
    }
    seenAddOns.add(a.code);
    if (qty > a.maxQty) {
      errors.push({ field: `addOns.${a.code}`, message: `${a.name}: at most ${a.maxQty}.` });
      continue;
    }
    if (a.exclusiveGroup) {
      const other = groups.get(a.exclusiveGroup);
      if (other) {
        errors.push({
          field: `addOns.${a.code}`,
          message: `${a.name} cannot be combined with ${other}; choose one.`,
        });
        continue;
      }
      groups.set(a.exclusiveGroup, a.name);
    }
    const included = a.includedInTiers?.includes(tier.code) ?? false;
    lines.push({
      kind: "addon",
      code: a.code,
      label: qty > 1 ? `${a.name} × ${qty}` : a.name,
      qty,
      unitCents: included ? 0 : a.priceCents,
      amountCents: included ? 0 : a.priceCents * qty,
      taxable: a.taxable,
      minutes: included ? 0 : a.minutes * qty,
      note: included ? "Included in this tier" : a.taxable ? "Materials (taxed)" : "Labor",
    });
    if (!included) minutes += a.minutes * qty;
  }

  // ----- surcharges -------------------------------------------------------------
  const surchargeExplanations: { code: string; explanation: string }[] = [];
  const warnings: string[] = [];
  const sGroups = new Map<string, string>();
  const seenS = new Set<string>();
  for (const sel of input.surcharges ?? []) {
    const s = def.surcharges.find((x) => x.code === sel.code);
    const qty = sel.qty ?? 1;
    if (!s) {
      errors.push({
        field: `surcharges.${sel.code}`,
        message: `Unknown surcharge "${sel.code}". Options: ${def.surcharges.map((x) => x.code).join(", ")}.`,
      });
      continue;
    }
    if (seenS.has(s.code)) {
      errors.push({ field: `surcharges.${s.code}`, message: `${s.name} is listed twice.` });
      continue;
    }
    seenS.add(s.code);
    if (s.exclusiveGroup) {
      const other = sGroups.get(s.exclusiveGroup);
      if (other) {
        errors.push({
          field: `surcharges.${s.code}`,
          message: `${s.name} cannot be combined with ${other}; choose one.`,
        });
        continue;
      }
      sGroups.set(s.exclusiveGroup, s.name);
    }
    let unitCents: number;
    let lineQty = 1;
    switch (s.kind.type) {
      case "fixed":
        unitCents = s.kind.cents;
        break;
      case "percent":
        unitCents = applyPercent(baseCents, s.kind.percent);
        break;
      case "perUnit":
        if (qty > s.kind.maxQty) {
          errors.push({
            field: `surcharges.${s.code}`,
            message: `${s.name}: at most ${s.kind.maxQty} ${s.kind.unitLabel}.`,
          });
          continue;
        }
        unitCents = s.kind.centsPerUnit;
        lineQty = qty;
        break;
    }
    lines.push({
      kind: "surcharge",
      code: s.code,
      label: lineQty > 1 ? `${s.name} (${lineQty} ${surchargeUnit(s)})` : s.name,
      qty: lineQty,
      unitCents,
      amountCents: unitCents * lineQty,
      taxable: false,
      minutes: s.minutes,
      note: `${surchargePriceLabel(s)}. Why: ${s.explanation}`,
    });
    minutes += s.minutes;
    surchargeExplanations.push({ code: s.code, explanation: s.explanation });
    if (s.confirmOnSite) warnings.push(`${s.name}: price confirmed on site by the crew.`);
  }

  // ----- frequency discount (base only) ------------------------------------------
  const freqCode = input.frequency ?? "one_time";
  const freqs = def.frequencies ?? [{ code: "one_time", name: "One-time", discountPercent: 0 }];
  const freq = freqs.find((f) => f.code === freqCode);
  let discountCents = 0;
  if (!freq) {
    errors.push({
      field: "frequency",
      message: `${def.name} is not offered as "${freqCode}". Options: ${freqs.map((f) => f.code).join(", ")}.`,
    });
  } else if (freq.discountPercent > 0) {
    discountCents = applyPercent(baseCents, freq.discountPercent);
    lines.push({
      kind: "discount",
      code: `freq-${freq.code}`,
      label: `${freq.name} discount (${freq.discountPercent}% off base)`,
      qty: 1,
      unitCents: -discountCents,
      amountCents: -discountCents,
      taxable: false,
      note: freq.note,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const subtotalCents = lines
    .filter((l) => l.kind !== "discount")
    .reduce((s, l) => s + l.amountCents, 0);
  const materialsCents = lines.filter((l) => l.taxable).reduce((s, l) => s + l.amountCents, 0);
  // Discounts only touch the (untaxed) base, so the taxable subtotal is materials only.
  const taxableCents = materialsCents;
  const taxCents = computeTax(taxableCents);
  const laborCents = subtotalCents - discountCents - materialsCents;

  const notes = [
    `Labor ${formatUsd(laborCents)} (not taxed) + materials ${formatUsd(materialsCents)} (taxed).`,
    `Estimated time on site: about ${formatDuration(minutes)}.`,
  ];
  if (tier.crew > 1) notes.push(`${tier.crew}-person crew.`);

  return {
    ok: true,
    tierName: tier.name,
    laborCents,
    materialsCents,
    surchargeExplanations,
    warnings,
    quote: {
      currency: "USD",
      lines,
      subtotalCents,
      discountCents,
      shippingCents: 0,
      taxableCents,
      taxRateBps: TAX_RATE_BPS,
      taxCents,
      totalCents: subtotalCents - discountCents + taxCents,
      durationMin: minutes,
      notes,
      taxDisclaimer: TAX_DISCLAIMER,
    },
  };
}

function surchargeUnit(s: ServiceSurcharge): string {
  return s.kind.type === "perUnit" ? s.kind.unitLabel : "";
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Slots (60-min each) a job of `durationMin` occupies. */
export function slotsNeeded(durationMin: number, slotMinutes = 60): number {
  return Math.max(1, Math.ceil(durationMin / slotMinutes));
}
