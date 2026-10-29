/**
 * Customer-facing option lists for one service (guided cards and the booking form's
 * "Service details"). Everything comes from src/config/pricing.ts; prices are display labels
 * only — totals are always computed by `quoteService`.
 */
import type { ServiceAddOnGroup, ServiceOptions } from "@/contracts";
import {
  formatUsd,
  getServiceDefinition,
  servicesForBusiness,
  type ServiceDefinition,
} from "@/config/pricing";
import { formatDuration } from "@/ui-lib/format";
import { surchargePriceLabel } from "./pricing";

/** What the tier choice means, per service. */
const TIER_LABELS: Record<string, string> = {
  "tv-mounting": "TV size",
  "lawn-mowing": "Lawn size",
  "standard-clean": "Home size",
  "deep-clean": "Home size",
  "move-clean": "Home size",
};

const SURCHARGE_LABELS: Record<string, string> = {
  "tv-mounting": "Wall conditions",
  "lawn-mowing": "Yard conditions",
  "standard-clean": "Larger homes",
  "deep-clean": "Larger homes",
  "move-clean": "Larger homes",
};

/** Exclusive add-on groups (config `exclusiveGroup`): heading + the "no add-on" choice. */
const GROUP_LABELS: Record<string, { label: string; noneLabel: string }> = {
  mount: { label: "Mount", noneLabel: "I have my own mount" },
  cables: { label: "Cable management", noneLabel: "No cable management" },
};

const EXTRAS_KEY = "extras";

const timeLabel = (min: number) => (min > 0 ? `+${formatDuration(min)}` : undefined);

function addOnGroups(def: ServiceDefinition): ServiceAddOnGroup[] {
  const groups = new Map<string, ServiceAddOnGroup>();
  const extras: ServiceAddOnGroup = {
    key: EXTRAS_KEY,
    label: "Extras",
    exclusive: false,
    items: [],
  };
  for (const a of def.addOns) {
    const item = {
      code: a.code,
      name: a.name,
      description: a.description,
      priceLabel: `+${formatUsd(a.priceCents)}${a.unitLabel ? ` per ${a.unitLabel}` : ""}`,
      timeLabel: timeLabel(a.minutes),
      maxQty: a.maxQty,
      unitLabel: a.unitLabel,
      includedInTiers: [...(a.includedInTiers ?? [])],
    };
    if (!a.exclusiveGroup) {
      extras.items.push(item);
      continue;
    }
    let g = groups.get(a.exclusiveGroup);
    if (!g) {
      const labels = GROUP_LABELS[a.exclusiveGroup];
      g = {
        key: a.exclusiveGroup,
        label: labels?.label ?? "Choose one",
        exclusive: true,
        noneLabel: labels?.noneLabel ?? "None",
        items: [],
      };
      groups.set(a.exclusiveGroup, g);
    }
    g.items.push(item);
  }
  return [...groups.values(), ...(extras.items.length ? [extras] : [])];
}

/** The option view of one service definition. */
export function serviceOptionsFor(def: ServiceDefinition): ServiceOptions {
  const minTier = Math.min(...def.tiers.map((t) => t.priceCents));
  // Crew size only matters to the customer when it differs between tiers.
  const crewVaries = new Set(def.tiers.map((t) => t.crew)).size > 1;
  const frequencies = def.frequencies?.length
    ? def.frequencies
    : [{ code: "one_time" as const, name: "One-time", discountPercent: 0 }];
  return {
    serviceCode: def.code,
    name: def.name,
    description: def.description,
    includes: [...def.includes],
    fromLabel: `From ${formatUsd(minTier)}`,
    tierLabel: TIER_LABELS[def.code] ?? "Size",
    tiers: def.tiers.map((t) => ({
      code: t.code,
      name: t.name,
      description: t.description,
      priceLabel: formatUsd(t.priceCents),
      durationLabel: `About ${formatDuration(t.durationMin)}`,
      crewLabel: crewVaries && t.crew > 1 ? `${t.crew}-person crew` : undefined,
      extraUnit: t.extraUnit
        ? {
            name: t.extraUnit.name,
            priceLabel: `+${formatUsd(t.extraUnit.priceCents)} per ${t.extraUnit.name}`,
            maxQty: t.extraUnit.maxQty,
          }
        : undefined,
    })),
    addOnGroups: addOnGroups(def),
    surchargeLabel: SURCHARGE_LABELS[def.code] ?? "Conditions",
    surcharges: def.surcharges.map((s) => ({
      code: s.code,
      name: s.name,
      condition: s.condition,
      priceLabel: surchargePriceLabel(s).replace(/of base$/, "of the base price"),
      timeLabel: timeLabel(s.minutes),
      explanation: s.explanation,
      exclusiveGroup: s.exclusiveGroup,
      perUnit:
        s.kind.type === "perUnit"
          ? { unitLabel: s.kind.unitLabel, maxQty: s.kind.maxQty }
          : undefined,
      confirmOnSite: s.confirmOnSite ?? false,
    })),
    frequencies: frequencies.map((f) => ({
      code: f.code,
      name: f.name,
      discountLabel: f.discountPercent > 0 ? `${f.discountPercent}% off the base visit` : undefined,
      note: f.note,
    })),
    notes: [...(def.notes ?? [])],
  };
}

/** Options for one service of this business, or null for an unknown code. */
export function buildServiceOptions(
  businessId: string,
  serviceCode: string,
): ServiceOptions | null {
  const def = getServiceDefinition(businessId, serviceCode);
  return def ? serviceOptionsFor(def) : null;
}

/** Options for every service of this business (empty for product businesses). */
export function serviceOptionsForBusiness(businessId: string): ServiceOptions[] {
  return servicesForBusiness(businessId).map(serviceOptionsFor);
}
