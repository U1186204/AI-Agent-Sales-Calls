import { describe, expect, it } from "vitest";
import { BUSINESS_SLUGS } from "@/contracts";
import { BUSINESSES } from "@/config/businesses";
import { DEMO_SECRETS, parseEnv } from "@/config/env";
import { costMicros, priceForModel } from "@/config/models";
import {
  applyBps,
  formatUsd,
  SERVICE_CATALOG,
  shippingZoneForZip,
  TAX_RATE_BPS,
  ZONE_RATES,
} from "@/config/pricing";
import { addDays, localDateString, zonedTimeToUtc } from "@/lib/tz";
import { ELECTRICAL_PRODUCTS, PLUMBING_PRODUCTS } from "../../prisma/seed/products";
import { computeTestDates } from "../../prisma/seed/test-dates";

describe("env", () => {
  it("parses an empty environment with demo defaults", () => {
    const e = parseEnv({});
    expect(e.OASIS_MODEL).toBe("claude-haiku-4-5");
    expect(e.OASIS_MAX_TOOL_ROUNDS).toBe(6);
    expect(e.OASIS_SESSION_BUDGET_USD).toBe(0.25);
    expect(e.OASIS_DAILY_BUDGET_USD).toBe(2);
    expect(e.OASIS_MAX_TURNS).toBe(40);
    expect(e.OASIS_MAX_INPUT_CHARS).toBe(2000);
    expect(e.RATE_LIMIT_IP_PER_10MIN).toBe(20);
    expect(e.OASIS_LLM_TIMEOUT_MS).toBe(30_000);
    expect(e.OASIS_FAULT).toBe("none");
    expect(e.llmEnabled).toBe(false);
    expect(e.emailProvider).toBe("mock");
    expect(e.smsProvider).toBe("mock");
    expect(e.demo.ownerPassword).toBe(true);
    expect(e.OWNER_PASSWORD_HASH).toBe(DEMO_SECRETS.OWNER_PASSWORD_HASH);
  });

  it("treats blank strings as unset and coerces numbers", () => {
    const e = parseEnv({ ANTHROPIC_API_KEY: "", OASIS_MAX_TURNS: "12", TRUST_PROXY: "true" });
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.OASIS_MAX_TURNS).toBe(12);
    expect(e.TRUST_PROXY).toBe(true);
  });

  it("accepts an OWNER_PASSWORD_HASH with .env-escaped dollar signs", () => {
    const escaped = DEMO_SECRETS.OWNER_PASSWORD_HASH.split("$").join("\\$");
    expect(parseEnv({ OWNER_PASSWORD_HASH: escaped }).OWNER_PASSWORD_HASH).toBe(
      DEMO_SECRETS.OWNER_PASSWORD_HASH,
    );
  });

  it("rejects bad values with a readable error", () => {
    expect(() => parseEnv({ OASIS_ENCRYPTION_KEY: "short" })).toThrow(/OASIS_ENCRYPTION_KEY/);
    expect(() => parseEnv({ OASIS_FAULT: "explode" })).toThrow(/OASIS_FAULT/);
    expect(() => parseEnv({ OWNER_PASSWORD_HASH: "plain" })).toThrow(/OWNER_PASSWORD_HASH/);
  });
});

describe("models", () => {
  it("prices Haiku/Sonnet/Opus and resolves dated ids", () => {
    expect(priceForModel("claude-haiku-4-5-20251001").inputPerMTok).toBe(1);
    expect(priceForModel("claude-sonnet-5-5").outputPerMTok).toBe(10);
    expect(priceForModel("unknown-model").outputPerMTok).toBe(20);
    // 80K in + 3K out on Haiku = $0.095
    expect(costMicros("claude-haiku-4-5", { inputTokens: 80_000, outputTokens: 3_000 })).toBe(
      95_000,
    );
  });
});

describe("businesses", () => {
  it("matches the contract slugs", () => {
    expect(BUSINESSES.map((b) => b.id)).toEqual([...BUSINESS_SLUGS]);
  });
  it("service businesses have booking hours and valid timezones", () => {
    for (const b of BUSINESSES) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: b.timezone })).not.toThrow();
      expect(b.notifyPhone).toMatch(/^\+1\d{3}55501\d{2}$/);
      if (b.kind === "service") expect(b.bookingHours.length).toBeGreaterThan(0);
      else expect(b.bookingHours).toHaveLength(0);
    }
  });
});

describe("pricing config", () => {
  it("rounds tax half-up in integer cents", () => {
    expect(TAX_RATE_BPS).toBe(750);
    expect(applyBps(27800, TAX_RATE_BPS)).toBe(2085); // 7.5% of $278.00
    expect(applyBps(10, TAX_RATE_BPS)).toBe(1); // 0.75 → 1
    expect(applyBps(6, TAX_RATE_BPS)).toBe(0); // 0.45 → 0
    expect(applyBps(20, TAX_RATE_BPS)).toBe(2); // 1.5 → 2
    expect(formatUsd(63700)).toBe("$637.00");
    expect(formatUsd(5)).toBe("$0.05");
  });

  it.each([
    ["46241", 2],
    ["45202", 3], // OH
    ["60601", 3], // IL
    ["10001", 4], // NY
    ["30301", 4], // GA
    ["33101", 5], // FL
    ["02101", 5], // MA
    ["75201", 5], // TX
    ["80202", 7], // CO
    ["90001", 8], // CA
    ["99501", 8], // AK — ships (no region lock)
    ["96813", 8], // HI — ships
    ["00901", 8], // PR
  ])("ZIP %s ships in zone %i", (zip, zone) => {
    expect(shippingZoneForZip(zip)?.zone).toBe(zone);
  });

  it("matches the research rate table", () => {
    expect(ZONE_RATES[7].baseCents + ZONE_RATES[7].perLbCents * 23).toBe(4190); // Denver example
  });

  it("service catalog has unique codes and integer-cent prices", () => {
    const codes = SERVICE_CATALOG.map((s) => `${s.businessId}/${s.code}`);
    expect(new Set(codes).size).toBe(codes.length);
    for (const s of SERVICE_CATALOG) {
      for (const t of s.tiers) {
        expect(Number.isInteger(t.priceCents)).toBe(true);
        expect(t.durationMin).toBeGreaterThan(0);
      }
      for (const a of s.addOns) expect(Number.isInteger(a.priceCents)).toBe(true);
      for (const x of s.surcharges) expect(x.explanation.length).toBeGreaterThan(40);
    }
    const tv = SERVICE_CATALOG.find((s) => s.code === "tv-mounting")!;
    const price = (code: string) =>
      [...tv.addOns, ...tv.tiers].find((x) => x.code === code)?.priceCents ?? 0;
    const sur = (code: string) => {
      const k = tv.surcharges.find((x) => x.code === code)?.kind;
      return k?.type === "fixed" ? k.cents : 0;
    };
    // Research example: $169 + $129 + $149 + $100 + $90 = $637
    expect(
      price("L") +
        price("mount-full-motion") +
        price("in-wall-concealment") +
        sur("above-fireplace") +
        sur("masonry-surface"),
    ).toBe(63700);
  });
});

describe("seed data", () => {
  it("has 25 electrical and 25 plumbing products with unique SKUs", () => {
    expect(ELECTRICAL_PRODUCTS).toHaveLength(25);
    expect(PLUMBING_PRODUCTS).toHaveLength(25);
    const skus = [...ELECTRICAL_PRODUCTS, ...PLUMBING_PRODUCTS].map((p) => p.sku);
    expect(new Set(skus).size).toBe(50);
    expect(ELECTRICAL_PRODUCTS.filter((p) => p.qtyOnHand === 0)).toHaveLength(3);
    expect(PLUMBING_PRODUCTS.filter((p) => p.qtyOnHand === 0)).toHaveLength(3);
  });

  it("computes fully-booked test dates on open days", () => {
    const t = computeTestDates(new Date("2026-10-05T18:00:00Z"));
    expect(t.services["mountpro-tv"].fullyBooked).toEqual(["2026-10-12"]);
    expect(t.services["mountpro-tv"].lastSlotOnly).toBe("2026-10-14");
    expect(t.services["greenstripe-lawn"].fullyBooked).toEqual(["2026-10-15"]);
    expect(t.services["brightnest-cleaning"].fullyBooked).toEqual(["2026-10-19"]);
  });
});

describe("tz helpers", () => {
  it("converts local business time to UTC across DST", () => {
    expect(zonedTimeToUtc("2026-10-05", "09:00", "America/Denver").toISOString()).toBe(
      "2026-10-05T15:00:00.000Z",
    );
    expect(zonedTimeToUtc("2026-12-07", "09:00", "America/Denver").toISOString()).toBe(
      "2026-12-07T16:00:00.000Z",
    );
    expect(zonedTimeToUtc("2026-11-02", "08:00", "America/Los_Angeles").toISOString()).toBe(
      "2026-11-02T16:00:00.000Z",
    );
    expect(localDateString(new Date("2026-10-06T03:00:00Z"), "America/Los_Angeles")).toBe(
      "2026-10-05",
    );
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
