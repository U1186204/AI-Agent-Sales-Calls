/** Pure ServiceConfig editing helpers used by the spec picker and "Service details". */
import { describe, expect, it } from "vitest";
import { buildServiceOptions } from "@/domain/service-options";
import {
  chooseExclusive,
  chooseTier,
  configSummary,
  defaultConfig,
  includedInTier,
  sameConfig,
  sanitizeConfig,
  setAddOn,
  setQty,
  setSurcharge,
} from "@/ui-lib/service-config";

const tv = buildServiceOptions("mountpro-tv", "tv-mounting")!;
const lawn = buildServiceOptions("greenstripe-lawn", "lawn-mowing")!;
const deep = buildServiceOptions("brightnest-cleaning", "deep-clean")!;

describe("service-config helpers", () => {
  it("setQty adds, updates in place and removes at 0", () => {
    const a = setQty([], "x", 1);
    expect(setQty([...a, { code: "y", qty: 1 }], "x", 3)).toEqual([
      { code: "x", qty: 3 },
      { code: "y", qty: 1 },
    ]);
    expect(setQty(a, "x", 0)).toEqual([]);
  });

  it("exclusive add-on groups keep one choice (or none)", () => {
    let c = defaultConfig(tv);
    c = chooseExclusive(tv, c, "mount", "mount-tilt");
    c = chooseExclusive(tv, c, "mount", "mount-full-motion");
    expect(c.addOns).toEqual([{ code: "mount-full-motion", qty: 1 }]);
    c = setAddOn(c, "soundbar-mount", 1);
    c = chooseExclusive(tv, c, "mount", null);
    expect(c.addOns).toEqual([{ code: "soundbar-mount", qty: 1 }]);
    // unknown group or code: unchanged / ignored
    expect(chooseExclusive(tv, c, "nope", "x")).toBe(c);
    expect(chooseExclusive(tv, c, "mount", "soundbar-mount").addOns).toEqual(c.addOns);
  });

  it("exclusive surcharges: turning one on turns its rival off", () => {
    let c = defaultConfig(lawn);
    c = setSurcharge(lawn, c, "overgrown", 1);
    c = setSurcharge(lawn, c, "steep-slope", 1);
    c = setSurcharge(lawn, c, "severely-overgrown", 1);
    expect(c.surcharges.map((s) => s.code).sort()).toEqual(["severely-overgrown", "steep-slope"]);
  });

  it("sanitize drops foreign codes, clamps quantities and resets unknown frequency", () => {
    const c = sanitizeConfig(tv, {
      serviceCode: "lawn-mowing",
      tierCode: "zz",
      extraUnits: 5,
      addOns: [
        { code: "device-shelf", qty: 9 },
        { code: "edging", qty: 1 },
      ],
      surcharges: [{ code: "overgrown", qty: 1 }],
      frequency: "weekly",
    });
    expect(c).toEqual({
      serviceCode: "tv-mounting",
      tierCode: "S",
      extraUnits: 0,
      addOns: [{ code: "device-shelf", qty: 2 }],
      surcharges: [],
      frequency: "one_time",
    });
  });

  it("tier switch keeps extra units only where the tier has them", () => {
    let c = chooseTier(lawn, defaultConfig(lawn), "XL");
    c = { ...c, extraUnits: 3 };
    expect(chooseTier(lawn, c, "XL").extraUnits).toBe(3);
    expect(chooseTier(lawn, c, "M").extraUnits).toBe(0);
    expect(chooseTier(lawn, { ...c, extraUnits: 50 }, "XL").extraUnits).toBe(9);
  });

  it("included add-ons and the summary line", () => {
    const c = { ...defaultConfig(deep), tierCode: "3BR" };
    const baseboards = deep.addOnGroups
      .flatMap((g) => g.items)
      .find((i) => i.code === "baseboards")!;
    expect(includedInTier(baseboards, c)).toBe(true);
    const tvc = setSurcharge(
      tv,
      chooseExclusive(tv, chooseTier(tv, defaultConfig(tv), "L"), "mount", "mount-tilt"),
      "above-fireplace",
      1,
    );
    expect(configSummary(tv, tvc)).toBe(
      'Large (56"–70") · Tilting mount supplied · Above fireplace',
    );
    expect(
      configSummary(lawn, {
        ...chooseTier(lawn, defaultConfig(lawn), "XL"),
        extraUnits: 2,
        frequency: "weekly",
      }),
    ).toBe("Extra large (over 1 acre) · +2 additional acres · Weekly");
  });

  it("sameConfig ignores order and tier case", () => {
    const a = {
      ...defaultConfig(tv),
      addOns: [
        { code: "a", qty: 1 },
        { code: "b", qty: 1 },
      ],
    };
    const b = {
      ...a,
      tierCode: "s",
      addOns: [
        { code: "b", qty: 1 },
        { code: "a", qty: 1 },
      ],
    };
    expect(sameConfig(a, b)).toBe(true);
    expect(sameConfig(a, { ...a, frequency: "weekly" })).toBe(false);
  });
});
