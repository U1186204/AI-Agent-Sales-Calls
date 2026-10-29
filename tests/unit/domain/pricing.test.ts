/** Pure pricing / shipping / tax / slot-run tests (no DB). */
import { describe, expect, it } from "vitest";
import { getServiceDefinition, TAX_RATE_BPS } from "@/config/pricing";
import { findRuns } from "@/domain/availability";
import { zipInServiceArea } from "@/domain/catalog";
import { addressSummary, maskEmail, maskName, maskPhone } from "@/domain/mask";
import { priceProducts, priceService, slotsNeeded } from "@/domain/pricing";
import { quoteShipping } from "@/domain/shipping";
import { computeTax } from "@/domain/tax";

const romex = {
  sku: "EL-WIR-1222-250",
  name: "Romex 12/2",
  unit: "roll",
  priceCents: 17900,
  weightLb: 19,
  qty: 1,
};
const toilet = {
  sku: "PL-TOI-ELON",
  name: "Toilet",
  unit: "each",
  priceCents: 27900,
  weightLb: 85,
  qty: 2,
};

describe("shipping by zone + weight (AT-22)", () => {
  // One 19 lb roll ($179, below the free threshold): base + perLb × 19
  const cases: [string, string, number, number][] = [
    ["AK", "99501", 8, 1275 + 155 * 19],
    ["HI", "96813", 8, 1275 + 155 * 19],
    ["FL", "33101", 5, 1050 + 90 * 19],
    ["CA", "90210", 8, 1275 + 155 * 19],
    ["NY", "10001", 4, 975 + 70 * 19],
    ["TX", "75201", 5, 1050 + 90 * 19],
    ["PR", "00901", 8, 1275 + 155 * 19],
    ["NY ZIP+4", "10001-1234", 4, 975 + 70 * 19],
    ["IN", "46204", 2, 850 + 45 * 19],
  ];
  it.each(cases)("%s %s → zone %i, %i cents", (_label, zip, zone, cents) => {
    const s = quoteShipping([{ weightLb: 19, qty: 1 }], 17900, zip);
    expect(s).not.toBeNull();
    expect(s!.zone).toBe(zone);
    expect(s!.totalCents).toBe(cents);
    expect(s!.freeShippingApplied).toBe(false);
  });

  it("rejects malformed ZIPs only", () => {
    expect(quoteShipping([{ weightLb: 1, qty: 1 }], 100, "1234")).toBeNull();
    expect(quoteShipping([{ weightLb: 1, qty: 1 }], 100, "ABCDE")).toBeNull();
  });

  it("rounds weight up with a 1 lb minimum and no float drift", () => {
    expect(quoteShipping([{ weightLb: 0.2, qty: 1 }], 100, "46204")!.billableLb).toBe(1);
    // 1.1 × 10 = 11.000000000000002 in floating point — must bill 11, not 12
    expect(quoteShipping([{ weightLb: 1.1, qty: 10 }], 100, "46204")!.billableLb).toBe(11);
    expect(quoteShipping([{ weightLb: 2.5, qty: 3 }], 100, "46204")!.billableLb).toBe(8);
  });

  it("free shipping at $249+, but heavy units still pay their weight share + $25 each", () => {
    const free = quoteShipping([{ weightLb: 19, qty: 2 }], 35800, "90210")!;
    expect(free.freeShippingApplied).toBe(true);
    expect(free.totalCents).toBe(0);

    const heavy = quoteShipping(
      [
        { weightLb: 85, qty: 2 },
        { weightLb: 1, qty: 1 },
      ],
      56500,
      "90210",
    )!;
    expect(heavy.heavyUnits).toBe(2);
    expect(heavy.handlingCents).toBe(5000);
    expect(heavy.transportCents).toBe(1275 + 155 * 170);
    expect(heavy.totalCents).toBe(1275 + 155 * 170 + 5000);
  });

  it("heavy handling applies below the threshold too", () => {
    const s = quoteShipping([{ weightLb: 60, qty: 1 }], 10000, "46204")!;
    expect(s.totalCents).toBe(850 + 45 * 60 + 2500);
  });
});

describe("product quote + tax", () => {
  it("taxes goods only, never shipping, rounded half-up once per order", () => {
    const { quote } = priceProducts([{ ...romex, qty: 1 }], "10001");
    expect(quote.subtotalCents).toBe(17900);
    expect(quote.taxableCents).toBe(17900);
    expect(quote.taxCents).toBe(1343); // 17900 × 7.5% = 1342.5 → 1343
    expect(quote.shippingCents).toBe(975 + 70 * 19);
    expect(quote.totalCents).toBe(17900 + 1343 + 975 + 70 * 19);
    expect(quote.shipZone).toBe(4);
    expect(quote.lines.find((l) => l.kind === "shipping")?.taxable).toBe(false);
  });

  it("adds a handling line for 2 toilets ($50) and keeps totals consistent", () => {
    const { quote } = priceProducts([toilet], "75201");
    const handling = quote.lines.find((l) => l.kind === "handling");
    expect(handling?.amountCents).toBe(5000);
    expect(quote.shippingCents).toBe(1050 + 90 * 170 + 5000);
    expect(quote.totalCents).toBe(quote.subtotalCents + quote.shippingCents + quote.taxCents);
  });

  it("quotes goods only when no ZIP is given", () => {
    const { quote } = priceProducts([romex]);
    expect(quote.shippingCents).toBe(0);
    expect(quote.shipZone).toBeUndefined();
    expect(quote.notes.join(" ")).toMatch(/ZIP/);
  });

  it("computeTax", () => {
    expect(TAX_RATE_BPS).toBe(750);
    expect(computeTax(0)).toBe(0);
    expect(computeTax(1)).toBe(0);
    expect(computeTax(7)).toBe(1); // 0.525 → 1
    expect(computeTax(27800)).toBe(2085);
  });
});

describe("service quote (AT-30)", () => {
  const tv = getServiceDefinition("mountpro-tv", "tv-mounting")!;

  it("matches the SPEC example to the cent: 65in, full-motion, in-wall, above brick fireplace", () => {
    const r = priceService(tv, {
      serviceCode: "tv-mounting",
      tierCode: "L",
      extraUnits: 0,
      addOns: [
        { code: "mount-full-motion", qty: 1 },
        { code: "in-wall-concealment", qty: 1 },
      ],
      surcharges: [
        { code: "above-fireplace", qty: 1 },
        { code: "masonry-surface", qty: 1 },
      ],
      frequency: "one_time",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.quote;
    expect(q.subtotalCents).toBe(63700); // $169 + $129 + $149 + $100 + $90
    expect(q.taxableCents).toBe(12900 + 14900); // materials only
    expect(q.taxCents).toBe(2085);
    expect(q.totalCents).toBe(65785);
    expect(r.materialsCents).toBe(27800);
    expect(r.laborCents).toBe(63700 - 27800);
    expect(q.durationMin).toBe(75 + 15 + 45 + 15 + 30);
    expect(slotsNeeded(q.durationMin!)).toBe(3);
    const fire = q.lines.find((l) => l.code === "above-fireplace")!;
    expect(fire.amountCents).toBe(10000);
    expect(fire.taxable).toBe(false);
    expect(fire.note).toMatch(/fireplace/i);
    const why = r.surchargeExplanations.find((e) => e.code === "above-fireplace");
    expect(why?.explanation).toMatch(/ladder|chimney|heat/i);
  });

  it("percent surcharges apply to the base; frequency discounts the base only", () => {
    const lawn = getServiceDefinition("greenstripe-lawn", "lawn-mowing")!;
    const r = priceService(lawn, {
      serviceCode: "lawn-mowing",
      tierCode: "XL",
      extraUnits: 2,
      addOns: [{ code: "edging", qty: 1 }],
      surcharges: [{ code: "overgrown", qty: 1 }],
      frequency: "weekly",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const base = 11000 + 2 * 6000;
    expect(r.quote.lines.find((l) => l.code === "overgrown")?.amountCents).toBe(base / 2);
    expect(r.quote.discountCents).toBe(base / 10);
    expect(r.quote.subtotalCents).toBe(base + 1500 + base / 2);
    expect(r.quote.taxCents).toBe(0);
    expect(r.quote.totalCents).toBe(base + 1500 + base / 2 - base / 10);
    expect(r.quote.durationMin).toBe(80 + 90 + 10 + 20);
  });

  it("per-unit surcharge and included add-ons", () => {
    const deep = getServiceDefinition("brightnest-cleaning", "deep-clean")!;
    const r = priceService(deep, {
      serviceCode: "deep-clean",
      tierCode: "2BR",
      extraUnits: 0,
      addOns: [{ code: "baseboards", qty: 1 }],
      surcharges: [{ code: "large-home-sqft", qty: 300 }],
      frequency: "one_time",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.lines.find((l) => l.code === "baseboards")?.amountCents).toBe(0);
    expect(r.quote.lines.find((l) => l.code === "large-home-sqft")?.amountCents).toBe(300 * 12);
    expect(r.quote.totalCents).toBe(25000 + 3600);
  });

  it("returns structured validation errors", () => {
    const bad = priceService(tv, {
      serviceCode: "tv-mounting",
      tierCode: "M",
      extraUnits: 1,
      addOns: [
        { code: "mount-fixed", qty: 1 },
        { code: "mount-tilt", qty: 1 },
        { code: "device-shelf", qty: 3 },
        { code: "nope", qty: 1 },
      ],
      surcharges: [{ code: "zzz", qty: 1 }],
      frequency: "weekly",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const fields = bad.errors.map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "extraUnits",
        "addOns.mount-tilt",
        "addOns.device-shelf",
        "addOns.nope",
        "surcharges.zzz",
        "frequency",
      ]),
    );
    const tier = priceService(tv, {
      serviceCode: "tv-mounting",
      tierCode: "Q",
      extraUnits: 0,
      addOns: [],
      surcharges: [],
      frequency: "one_time",
    });
    expect(tier.ok).toBe(false);
  });
});

describe("slot runs", () => {
  const t0 = Date.UTC(2030, 0, 7, 15);
  const h = (i: number) => new Date(t0 + i * 3_600_000);
  const slot = (id: string, c: string, i: number, status = "open") => ({
    id,
    contractorId: c,
    startsAt: h(i),
    status,
  });

  it("needs consecutive open slots of the same contractor", () => {
    const slots = [
      slot("a0", "A", 0),
      slot("a1", "A", 1, "booked"),
      slot("a2", "A", 2),
      slot("a3", "A", 3),
      slot("b0", "B", 0),
      slot("b1", "B", 1),
      slot("b5", "B", 5), // gap: not consecutive with b1
    ];
    expect(
      findRuns(slots, 1)
        .map((r) => r.anchorId)
        .sort(),
    ).toEqual(["a0", "a2", "a3", "b0", "b1", "b5"].sort());
    const two = findRuns(slots, 2);
    expect(two.map((r) => r.anchorId).sort()).toEqual(["a2", "b0"]);
    expect(two.find((r) => r.anchorId === "a2")?.slotIds).toEqual(["a2", "a3"]);
    expect(findRuns(slots, 3)).toEqual([]);
  });
});

describe("service area (AT-32) + masking", () => {
  it("any accepts all ZIPs; prefix mode rejects others", () => {
    expect(zipInServiceArea({ mode: "any" }, "99501")).toBe(true);
    const area = { mode: "zipPrefixes" as const, prefixes: ["787", "786"] };
    expect(zipInServiceArea(area, "78701")).toBe(true);
    expect(zipInServiceArea(area, "78613-1234")).toBe(true);
    expect(zipInServiceArea(area, "10001")).toBe(false);
  });

  it("masks names, emails, phones", () => {
    expect(maskName("jane", "Smith")).toBe("J. Smith");
    expect(maskEmail("jane.smith@example.com")).toBe("j***@example.com");
    expect(maskPhone("+15125550123")).toBe("(***) ***-0123");
    expect(addressSummary({ city: "Austin", state: "TX", zip: "78701" })).toBe("Austin, TX 78701");
  });
});
