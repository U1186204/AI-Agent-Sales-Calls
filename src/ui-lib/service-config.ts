/**
 * Pure helpers for editing a ServiceConfig in the UI (guided cards and the booking form's
 * "Service details"). They only move codes and quantities around; prices always come from
 * the server. Client + server safe, no dependencies.
 */
import type { QtyCode, ServiceConfig, ServiceOptions } from "@/contracts";

export const qtyOf = (list: readonly QtyCode[], code: string): number =>
  list.find((x) => x.code === code)?.qty ?? 0;

/** Set one code's quantity (0 removes it), keeping the others in order. */
export function setQty(list: readonly QtyCode[], code: string, qty: number): QtyCode[] {
  const rest = list.filter((x) => x.code !== code);
  if (qty <= 0) return rest;
  const i = list.findIndex((x) => x.code === code);
  const next = { code, qty: Math.floor(qty) };
  if (i < 0) return [...rest, next];
  return [...list.slice(0, i), next, ...list.slice(i + 1)];
}

/** A default configuration: first tier, nothing added, one-time. */
export function defaultConfig(options: ServiceOptions): ServiceConfig {
  return {
    serviceCode: options.serviceCode,
    tierCode: options.tiers[0]!.code,
    extraUnits: 0,
    addOns: [],
    surcharges: [],
    frequency: "one_time",
  };
}

/** Drop codes this service does not offer and clamp quantities to their limits. */
export function sanitizeConfig(options: ServiceOptions, config: ServiceConfig): ServiceConfig {
  const tier =
    options.tiers.find((t) => t.code.toLowerCase() === config.tierCode.toLowerCase()) ??
    options.tiers[0]!;
  const addOnMax = new Map(
    options.addOnGroups.flatMap((g) => g.items).map((i) => [i.code, i.maxQty] as const),
  );
  const surchargeMax = new Map(
    options.surcharges.map((s) => [s.code, s.perUnit?.maxQty ?? 1] as const),
  );
  const clamp = (list: readonly QtyCode[], max: Map<string, number>) =>
    list
      .filter((x) => max.has(x.code))
      .map((x) => ({ code: x.code, qty: Math.min(Math.max(1, x.qty), max.get(x.code)!) }));
  return {
    serviceCode: options.serviceCode,
    tierCode: tier.code,
    extraUnits: tier.extraUnit
      ? Math.min(Math.max(0, config.extraUnits), tier.extraUnit.maxQty)
      : 0,
    addOns: clamp(config.addOns, addOnMax),
    surcharges: clamp(config.surcharges, surchargeMax),
    frequency: options.frequencies.some((f) => f.code === config.frequency)
      ? config.frequency
      : "one_time",
  };
}

/** Switch tier; a tier without extra units resets them. */
export function chooseTier(
  options: ServiceOptions,
  config: ServiceConfig,
  tierCode: string,
): ServiceConfig {
  return sanitizeConfig(options, { ...config, tierCode });
}

/** Pick one add-on of an exclusive group (or none with `code = null`). */
export function chooseExclusive(
  options: ServiceOptions,
  config: ServiceConfig,
  groupKey: string,
  code: string | null,
): ServiceConfig {
  const group = options.addOnGroups.find((g) => g.key === groupKey);
  if (!group) return config;
  const inGroup = new Set(group.items.map((i) => i.code));
  const addOns = config.addOns.filter((a) => !inGroup.has(a.code));
  return { ...config, addOns: code && inGroup.has(code) ? [...addOns, { code, qty: 1 }] : addOns };
}

export function setAddOn(config: ServiceConfig, code: string, qty: number): ServiceConfig {
  return { ...config, addOns: setQty(config.addOns, code, qty) };
}

/** Set a surcharge; turning one on turns off the others in its exclusive group. */
export function setSurcharge(
  options: ServiceOptions,
  config: ServiceConfig,
  code: string,
  qty: number,
): ServiceConfig {
  const s = options.surcharges.find((x) => x.code === code);
  let list = config.surcharges;
  if (qty > 0 && s?.exclusiveGroup) {
    const rivals = new Set(
      options.surcharges
        .filter((x) => x.exclusiveGroup === s.exclusiveGroup && x.code !== code)
        .map((x) => x.code),
    );
    list = list.filter((x) => !rivals.has(x.code));
  }
  return { ...config, surcharges: setQty(list, code, qty) };
}

/** Is the add-on already included in the chosen tier (shown as "Included", no charge)? */
export const includedInTier = (
  item: { includedInTiers: readonly string[] },
  config: ServiceConfig,
) => item.includedInTiers.includes(config.tierCode);

/** "Large (56"–70") · Tilting mount supplied · Above fireplace · Weekly" */
export function configSummary(options: ServiceOptions, config: ServiceConfig): string {
  const tier = options.tiers.find((t) => t.code === config.tierCode);
  const items = new Map(options.addOnGroups.flatMap((g) => g.items).map((i) => [i.code, i]));
  const sur = new Map(options.surcharges.map((s) => [s.code, s]));
  const named = (list: readonly QtyCode[], names: Map<string, { name: string }>) =>
    list.flatMap((x) => {
      const n = names.get(x.code)?.name;
      return n ? [x.qty > 1 ? `${n} × ${x.qty}` : n] : [];
    });
  const freq = options.frequencies.find((f) => f.code === config.frequency);
  return [
    tier?.name,
    tier?.extraUnit && config.extraUnits > 0
      ? `+${config.extraUnits} ${tier.extraUnit.name}${config.extraUnits > 1 ? "s" : ""}`
      : undefined,
    ...named(config.addOns, items),
    ...named(config.surcharges, sur),
    freq && freq.code !== "one_time" ? freq.name : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Order-insensitive equality of two configurations. */
export function sameConfig(a: ServiceConfig, b: ServiceConfig): boolean {
  const norm = (c: ServiceConfig) =>
    JSON.stringify({
      ...c,
      tierCode: c.tierCode.toUpperCase(),
      addOns: [...c.addOns].sort((x, y) => x.code.localeCompare(y.code)),
      surcharges: [...c.surcharges].sort((x, y) => x.code.localeCompare(y.code)),
    });
  return norm(a) === norm(b);
}
