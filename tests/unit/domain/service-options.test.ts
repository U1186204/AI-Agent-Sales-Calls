/**
 * Customer-facing service options (guided cards + booking form "Service details"): every
 * option comes from src/config/pricing.ts, with display labels only.
 */
import { describe, expect, it } from "vitest";
import { ServiceOptions } from "@/contracts";
import { SERVICE_CATALOG, formatUsd } from "@/config/pricing";
import { buildServiceOptions, serviceOptionsForBusiness } from "@/domain";

describe("service options", () => {
  it("covers every tier, add-on, surcharge and frequency of every service, and parses", () => {
    for (const def of SERVICE_CATALOG) {
      const o = ServiceOptions.parse(buildServiceOptions(def.businessId, def.code));
      expect(o.tiers.map((t) => t.code)).toEqual(def.tiers.map((t) => t.code));
      expect(o.addOnGroups.flatMap((g) => g.items.map((i) => i.code)).sort()).toEqual(
        def.addOns.map((a) => a.code).sort(),
      );
      expect(o.surcharges.map((s) => s.code)).toEqual(def.surcharges.map((s) => s.code));
      expect(o.frequencies.map((f) => f.code)).toEqual(
        (def.frequencies ?? [{ code: "one_time" }]).map((f) => f.code),
      );
    }
  });

  it("MountPro: mount and cable groups are exclusive with a 'none' choice; extras are toggles", () => {
    const o = buildServiceOptions("mountpro-tv", "tv-mounting")!;
    expect(o.tierLabel).toBe("TV size");
    expect(o.surchargeLabel).toBe("Wall conditions");
    const [mount, cables, extras] = o.addOnGroups;
    expect(mount).toMatchObject({ key: "mount", label: "Mount", exclusive: true });
    expect(mount!.noneLabel).toBe("I have my own mount");
    expect(mount!.items.map((i) => i.code)).toEqual([
      "mount-fixed",
      "mount-tilt",
      "mount-full-motion",
    ]);
    expect(cables).toMatchObject({ key: "cables", label: "Cable management", exclusive: true });
    expect(cables!.items.map((i) => i.code)).toEqual(["in-wall-concealment", "on-wall-raceway"]);
    expect(extras).toMatchObject({ key: "extras", exclusive: false });
    expect(extras!.items.map((i) => i.code)).toEqual([
      "soundbar-mount",
      "new-outlet",
      "device-shelf",
      "unmount-old",
    ]);
    // XL/XXL send two technicians
    expect(o.tiers.find((t) => t.code === "XL")?.crewLabel).toBe("2-person crew");
    expect(o.tiers.find((t) => t.code === "S")?.crewLabel).toBeUndefined();
    // the "why" text is the config explanation, verbatim
    const fire = o.surcharges.find((s) => s.code === "above-fireplace")!;
    expect(fire.priceLabel).toBe("+$100.00");
    expect(fire.explanation).toMatch(/fireplace/);
    expect(o.fromLabel).toBe(`From ${formatUsd(9900)}`);
  });

  it("GreenStripe: extra acres, exclusive growth surcharges, base-only frequency discounts", () => {
    const o = buildServiceOptions("greenstripe-lawn", "lawn-mowing")!;
    expect(o.tiers.find((t) => t.code === "XL")?.extraUnit).toMatchObject({
      name: "additional acre",
      maxQty: 9,
    });
    const growth = o.surcharges.filter((s) => s.exclusiveGroup === "growth").map((s) => s.code);
    expect(growth).toEqual(["overgrown", "severely-overgrown"]);
    expect(o.surcharges.find((s) => s.code === "overgrown")?.priceLabel).toBe(
      "+50% of the base price",
    );
    expect(o.surcharges.find((s) => s.code === "severely-overgrown")?.confirmOnSite).toBe(true);
    expect(o.frequencies.find((f) => f.code === "weekly")?.discountLabel).toBe(
      "10% off the base visit",
    );
    expect(o.frequencies.find((f) => f.code === "one_time")?.discountLabel).toBeUndefined();
    expect(o.notes.join(" ")).toMatch(/base visit price only/);
  });

  it("BrightNest: three clean types; baseboards included in deep/move; sqft is per unit", () => {
    const all = serviceOptionsForBusiness("brightnest-cleaning");
    expect(all.map((s) => s.serviceCode)).toEqual(["standard-clean", "deep-clean", "move-clean"]);
    const deep = all[1]!;
    const baseboards = deep.addOnGroups
      .flatMap((g) => g.items)
      .find((i) => i.code === "baseboards");
    expect(baseboards?.includedInTiers).toContain("3BR");
    const std = all[0]!;
    expect(
      std.addOnGroups.flatMap((g) => g.items).find((i) => i.code === "baseboards")?.includedInTiers,
    ).toEqual([]);
    expect(std.surcharges[0]?.perUnit).toMatchObject({ maxQty: 10_000 });
    expect(std.frequencies.map((f) => f.code)).toEqual([
      "one_time",
      "monthly",
      "biweekly",
      "weekly",
    ]);
    expect(deep.frequencies.map((f) => f.code)).toEqual(["one_time"]);
    expect(
      std.addOnGroups.flatMap((g) => g.items).find((i) => i.code === "extra-bathroom")?.priceLabel,
    ).toBe("+$25.00 per bathroom");
  });

  it("product businesses and unknown codes have no options", () => {
    expect(serviceOptionsForBusiness("volt-supply")).toEqual([]);
    expect(buildServiceOptions("mountpro-tv", "lawn-mowing")).toBeNull();
    expect(buildServiceOptions("mountpro-tv", "nope")).toBeNull();
  });
});
