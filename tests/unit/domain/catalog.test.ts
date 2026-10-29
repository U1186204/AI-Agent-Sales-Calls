/** Catalog, inventory, quotes, policies, service area, isolation (AT-20/21/22/30/32/95). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkInventory,
  checkServiceArea,
  getBusinessProfile,
  getPolicies,
  getProduct,
  listBusinesses,
  listServices,
  quoteProducts,
  quoteService,
  searchCatalog,
} from "@/domain";
import { setupTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb("catalog");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

describe("businesses + catalog", () => {
  it("lists 5 businesses and exposes public profiles only", async () => {
    const list = await listBusinesses();
    expect(list.map((b) => b.id)).toHaveLength(5);
    const p = await getBusinessProfile("mountpro-tv");
    expect(p?.escalationResponse).toBeTruthy();
    expect(p).not.toHaveProperty("notifyEmail");
    expect(p).not.toHaveProperty("notifyPhone");
    expect(await getBusinessProfile("nope")).toBeNull();
  });

  it("searches products by name/category with stock status", async () => {
    const r = await searchCatalog("volt-supply", { query: "romex 12/2" });
    expect(r.results[0]?.sku).toBe("EL-WIR-1222-250");
    expect(r.results[0]?.inStock).toBe(true);
    const br = await searchCatalog("volt-supply", { category: "breakers", limit: 25 });
    expect(br.results.length).toBeGreaterThan(0);
    expect(br.results.every((x) => x.category === "Breakers")).toBe(true);
    const out = br.results.find((x) => x.sku === "EL-BRK-2P30");
    expect(out?.inStock).toBe(false);
    expect(r.categories).toContain("Wire & cable");
  });

  it("service businesses search their services", async () => {
    const r = await searchCatalog("brightnest-cleaning", { query: "deep" });
    expect(r.results).toEqual([]);
    expect(r.services?.[0]?.code).toBe("deep-clean");
    const lawn = await searchCatalog("greenstripe-lawn", {});
    expect(lawn.services?.map((s) => s.code)).toEqual(["lawn-mowing"]);
  });

  it("getProduct returns notFound for unknown SKUs", async () => {
    const ok = await getProduct("volt-supply", "el-wir-1222-250");
    expect("product" in ok && ok.product.priceCents).toBe(17900);
    const nf = await getProduct("volt-supply", "EL-NOPE");
    expect(nf).toMatchObject({ notFound: true, sku: "EL-NOPE" });
  });
});

describe("inventory (AT-20, AT-21)", () => {
  it("partial stock reports available qty; out of stock offers same-category alternatives", async () => {
    const { items } = await checkInventory("volt-supply", [
      { sku: "EL-WIR-1232-250", qty: 5 },
      { sku: "EL-BRK-2P30", qty: 1 },
      { sku: "EL-WIR-1222-250", qty: 2 },
      { sku: "EL-NOPE", qty: 1 },
    ]);
    const [partial, out, ok, missing] = items;
    expect(partial).toMatchObject({ status: "partial", available: 2, qtyOnHand: 2, requested: 5 });
    expect(partial!.alternatives.every((a) => a.category === "Wire & cable" && a.inStock)).toBe(
      true,
    );
    expect(out).toMatchObject({ status: "out_of_stock", available: 0 });
    expect(out!.alternatives.length).toBeGreaterThan(0);
    expect(out!.alternatives.every((a) => a.category === "Breakers" && a.qtyOnHand > 0)).toBe(true);
    expect(out!.alternatives.map((a) => a.sku)).not.toContain("EL-BRK-2P30");
    expect(ok).toMatchObject({ status: "in_stock", alternatives: [] });
    expect(missing).toMatchObject({ status: "not_found", available: 0 });
  });

  it("quoteProducts flags problems instead of throwing and never prices more than stock", async () => {
    const r = await quoteProducts(
      "volt-supply",
      [
        { sku: "EL-WIR-1232-250", qty: 5 },
        { sku: "EL-BRK-2P30", qty: 1 },
        { sku: "EL-XXX", qty: 1 },
      ],
      "99501",
    );
    expect("quote" in r).toBe(true);
    if (!("quote" in r)) return;
    expect(r.issues).toEqual(
      expect.arrayContaining([
        { sku: "EL-WIR-1232-250", problem: "insufficient_stock", available: 2 },
        { sku: "EL-BRK-2P30", problem: "out_of_stock", available: 0 },
        { sku: "EL-XXX", problem: "not_found" },
      ]),
    );
    const goods = r.quote.lines.filter((l) => l.kind === "goods");
    expect(goods).toHaveLength(1);
    expect(goods[0]).toMatchObject({ code: "EL-WIR-1232-250", qty: 2, amountCents: 63800 });
    // $638 ≥ $249 → free shipping (no heavy units: 27 lb rolls)
    expect(r.quote.shipZone).toBe(8);
    expect(r.quote.shippingCents).toBe(0);
    expect(r.quote.taxCents).toBe(4785);
    expect(r.quote.totalCents).toBe(63800 + 4785);

    const none = await quoteProducts("volt-supply", [{ sku: "EL-XXX", qty: 1 }]);
    expect(none).toMatchObject({ notFound: true });
  });

  it.each([
    ["AK", "99501", 8],
    ["HI", "96813", 8],
    ["FL", "33101", 5],
    ["CA", "94105", 8],
    ["NY", "10001", 4],
    ["TX", "73301", 5],
    ["PR", "00901", 8],
    ["ZIP+4", "33101-1234", 5],
  ])("ships to %s (%s) — zone %i, no region lock (AT-22)", async (_s, zip, zone) => {
    const r = await quoteProducts("flowline-plumbing", [{ sku: "PL-WAX-RING", qty: 1 }], zip);
    if (!("quote" in r)) throw new Error("expected quote");
    expect(r.quote.shipZone).toBe(zone);
    expect(r.quote.shippingCents).toBeGreaterThan(0);
  });
});

describe("services (AT-30) + policies + service area (AT-32)", () => {
  it("lists services with surcharge explanations", async () => {
    const { services } = await listServices("mountpro-tv");
    const fire = services[0]!.surcharges.find((s) => s.code === "above-fireplace");
    expect(fire?.price).toBe("+$100.00");
    expect(fire?.explanation).toMatch(/fireplace/);
  });

  it("quotes a TV install with add-on + surcharge, itemized with labor vs materials", async () => {
    const r = await quoteService("mountpro-tv", {
      serviceCode: "tv-mounting",
      tierCode: "m",
      addOns: [{ code: "mount-tilt" }],
      surcharges: [{ code: "above-fireplace" }],
    });
    if (!("quote" in r)) throw new Error(JSON.stringify(r));
    expect(r.quote.subtotalCents).toBe(12900 + 6500 + 10000);
    expect(r.materialsCents).toBe(6500);
    expect(r.laborCents).toBe(22900);
    expect(r.quote.taxCents).toBe(488); // 6500 × 7.5% = 487.5 → 488
    expect(r.quote.totalCents).toBe(29400 + 488);
    expect(r.durationMin).toBe(60 + 0 + 15);
    expect(r.surchargeExplanations[0]?.explanation).toMatch(/above a fireplace/i);
    expect(r.quote.lines.find((l) => l.code === "above-fireplace")?.note).toMatch(/Why:/);
  });

  it("returns structured notFound / invalid results", async () => {
    expect(
      await quoteService("mountpro-tv", { serviceCode: "lawn-mowing", tierCode: "S" }),
    ).toMatchObject({
      notFound: true,
    });
    const bad = await quoteService("mountpro-tv", {
      serviceCode: "tv-mounting",
      tierCode: "M",
      addOns: [{ code: "mount-fixed" }, { code: "mount-tilt" }],
    });
    expect(bad).toMatchObject({ invalid: true });
  });

  it("policies include surcharge explanations and filter by topic", async () => {
    const all = await getPolicies("mountpro-tv");
    expect(all.policies.some((p) => p.key === "surcharge:above-fireplace")).toBe(true);
    const fire = await getPolicies("mountpro-tv", "fireplace");
    expect(fire.policies.every((p) => /fireplace/i.test(p.title + p.text))).toBe(true);
    const ret = await getPolicies("volt-supply", "returns");
    expect(ret.policies[0]?.key).toBe("returns");
  });

  it("R2-7: the shipping policy says military APO/FPO/DPO addresses are not supported", async () => {
    for (const b of ["volt-supply", "flowline-plumbing"]) {
      for (const topic of ["APO", "military", "shipping"]) {
        const r = await getPolicies(b, topic);
        const shipping = r.policies.find((p) => p.key === "shipping");
        expect(shipping?.text).toMatch(/Military APO\/FPO\/DPO addresses .* not supported/);
      }
    }
  });

  it("default service area accepts any valid ZIP", async () => {
    expect((await checkServiceArea("greenstripe-lawn", "99501")).served).toBe(true);
    expect((await checkServiceArea("greenstripe-lawn", "00901-1234")).served).toBe(true);
    expect((await checkServiceArea("greenstripe-lawn", "123")).served).toBe(false);
  });
});

describe("data isolation (AT-95)", () => {
  it("electrical cannot see plumbing SKUs", async () => {
    expect(await getProduct("volt-supply", "PL-WAX-RING")).toMatchObject({ notFound: true });
    const s = await searchCatalog("volt-supply", { query: "toilet wax ring", limit: 25 });
    expect(s.results.every((p) => p.sku.startsWith("EL-"))).toBe(true);
    const all = await searchCatalog("volt-supply", { limit: 25 });
    expect(all.results.every((p) => p.sku.startsWith("EL-"))).toBe(true);
    const inv = await checkInventory("volt-supply", [{ sku: "PL-WAX-RING", qty: 1 }]);
    expect(inv.items[0]?.status).toBe("not_found");
    const q = await quoteProducts("volt-supply", [{ sku: "PL-WAX-RING", qty: 1 }]);
    expect(q).toMatchObject({ notFound: true });
  });
});
