/** Availability against the seed's fixture dates (AT-31). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/tz";
import { checkAvailability } from "@/domain";
import { setupTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb("availability");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

describe("checkAvailability (AT-31)", () => {
  it("a fully booked date says so and offers the nearest later openings", async () => {
    const date = t.dates.services["mountpro-tv"].fullyBooked[0]!;
    const r = await checkAvailability("mountpro-tv", { serviceCode: "tv-mounting", date });
    expect(r.fullyBooked).toBe(true);
    expect(r.slots).toEqual([]);
    expect(r.message).toMatch(/no opening/i);
    expect(r.nextAvailable.length).toBe(5);
    expect(r.nextAvailable.every((s) => s.localDate > date)).toBe(true);
    expect(r.timezone).toBe("America/Denver");
    // sorted ascending
    const times = r.nextAvailable.map((s) => s.startsAt);
    expect([...times].sort()).toEqual(times);
  });

  it("fully booked for every service business fixture", async () => {
    const lawn = t.dates.services["greenstripe-lawn"].fullyBooked[0]!;
    const r1 = await checkAvailability("greenstripe-lawn", {
      serviceCode: "lawn-mowing",
      date: lawn,
    });
    expect(r1.fullyBooked).toBe(true);
    expect(r1.nextAvailable.length).toBeGreaterThan(0);
    const clean = t.dates.services["brightnest-cleaning"].fullyBooked[0]!;
    const r2 = await checkAvailability("brightnest-cleaning", { durationMin: 90, date: clean });
    expect(r2.fullyBooked).toBe(true);
  });

  it("a day with only the last slot open fits a 1-hour job but not a 2-hour job", async () => {
    const date = t.dates.services["mountpro-tv"].lastSlotOnly!;
    const short = await checkAvailability("mountpro-tv", {
      selection: { serviceCode: "tv-mounting", tierCode: "M" },
      date,
    });
    expect(short.durationMin).toBe(60);
    expect(short.fullyBooked).toBe(false);
    expect(short.slots).toHaveLength(1);
    expect(short.slots[0]!.localTime).toBe("5:00 PM");
    expect(short.slots[0]!.localDate).toBe(date);

    const long = await checkAvailability("mountpro-tv", {
      selection: { serviceCode: "tv-mounting", tierCode: "XXL" },
      date,
    });
    expect(long.durationMin).toBe(120);
    expect(long.slotsNeeded).toBe(2);
    expect(long.fullyBooked).toBe(true);
    expect(long.nextAvailable.length).toBeGreaterThan(0);
  });

  it("a fragmented day has 1-hour gaps but no consecutive pair", async () => {
    const date = t.dates.services["brightnest-cleaning"].fragmented!;
    const oneHour = await checkAvailability("brightnest-cleaning", {
      durationMin: 60,
      date,
      limit: 20,
    });
    expect(oneHour.slots.length).toBeGreaterThan(0);
    const ninety = await checkAvailability("brightnest-cleaning", {
      selection: { serviceCode: "standard-clean", tierCode: "1BR" },
      date,
    });
    expect(ninety.durationMin).toBe(90);
    expect(ninety.fullyBooked).toBe(true);
  });

  it("ranges return future starts in business-local time within the range", async () => {
    const today = t.dates.services["mountpro-tv"].today;
    const from = addDays(today, 1);
    const to = addDays(today, 3);
    const r = await checkAvailability("mountpro-tv", {
      durationMin: 60,
      fromDate: from,
      toDate: to,
      limit: 20,
    });
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) {
      expect(s.localDate >= from && s.localDate <= to).toBe(true);
      expect(new Date(s.startsAt).getTime()).toBeGreaterThan(Date.now());
      expect(s.startsAt).toMatch(/Z$/);
    }
  });

  it("never offers past dates or dates beyond the 60-day horizon", async () => {
    const today = t.dates.services["mountpro-tv"].today;
    const past = await checkAvailability("mountpro-tv", {
      durationMin: 60,
      date: addDays(today, -3),
    });
    expect(past.slots).toEqual([]);
    expect(past.message).toMatch(/passed/);
    const far = await checkAvailability("mountpro-tv", {
      durationMin: 60,
      date: addDays(today, 90),
    });
    expect(far.slots).toEqual([]);
    expect(far.message).toMatch(/60 days/);
    const all = await checkAvailability("mountpro-tv", {
      durationMin: 60,
      toDate: addDays(today, 200),
      limit: 20,
    });
    expect(all.slots.every((s) => s.localDate <= all.horizonEnd)).toBe(true);
  });

  it("product businesses and unknown services return a message, not slots", async () => {
    expect((await checkAvailability("volt-supply", { date: "2030-01-01" })).slots).toEqual([]);
    const r = await checkAvailability("mountpro-tv", { serviceCode: "lawn-mowing" });
    expect(r.message).toMatch(/No service/);
  });
});
