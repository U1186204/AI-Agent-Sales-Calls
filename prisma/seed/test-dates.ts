/**
 * Deterministic availability fixtures for tests and evals.
 *
 * The seed blocks these local dates (in each business's timezone). Dates are relative to the
 * seed run, so the seed also writes them to `.data/seed-meta.json`; read them back with
 * `readSeedTestDates()` (falls back to computing from "now" if the file is missing).
 *
 *   mountpro-tv          fullyBooked: first open day ≥ today+7  (every slot booked)
 *                        lastSlotOnly: first open day ≥ today+9 (only the final slot of the
 *                                      day for one contractor is open)
 *   greenstripe-lawn     fullyBooked: first open day ≥ today+10
 *   brightnest-cleaning  fullyBooked: first open day ≥ today+14
 *                        fragmented:   first open day ≥ today+16 (alternate hours booked:
 *                                      1-hour gaps exist but no job ≥ 90 min fits)
 *
 * "Open day" = a weekday that has bookingHours in src/config/businesses.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BUSINESSES } from "../../src/config/businesses";
import { addDays, localDateString, weekdayOf } from "../../src/lib/tz";

export const SEED_META_PATH = path.join(".data", "seed-meta.json");

export interface ServiceTestDates {
  timezone: string;
  /** Local "today" at seed time. */
  today: string;
  /** Local dates with zero open slots. */
  fullyBooked: string[];
  /** Local date where only the last slot of the day (one contractor) is open. */
  lastSlotOnly?: string;
  /** Local date with only isolated 1-hour openings. */
  fragmented?: string;
}

export interface SeedTestDates {
  seededAt: string;
  horizonDays: number;
  services: Record<"mountpro-tv" | "greenstripe-lawn" | "brightnest-cleaning", ServiceTestDates>;
}

function isOpenDay(businessId: string, date: string): boolean {
  const b = BUSINESSES.find((x) => x.id === businessId);
  if (!b) throw new Error(`Unknown business ${businessId}`);
  const wd = weekdayOf(date);
  return b.bookingHours.some((h) => h.day === wd);
}

function firstOpenDayFrom(businessId: string, date: string, taken: Set<string>): string {
  let d = date;
  for (let i = 0; i < 14; i++) {
    if (isOpenDay(businessId, d) && !taken.has(d)) {
      taken.add(d);
      return d;
    }
    d = addDays(d, 1);
  }
  throw new Error(`No open day found for ${businessId} from ${date}`);
}

export function computeTestDates(now: Date = new Date(), horizonDays = 60): SeedTestDates {
  const tzOf = (id: string) => BUSINESSES.find((b) => b.id === id)?.timezone ?? "UTC";

  const mk = (id: string) => {
    const timezone = tzOf(id);
    const today = localDateString(now, timezone);
    return { id, timezone, today, taken: new Set<string>() };
  };

  const tv = mk("mountpro-tv");
  const lawn = mk("greenstripe-lawn");
  const clean = mk("brightnest-cleaning");

  return {
    seededAt: now.toISOString(),
    horizonDays,
    services: {
      "mountpro-tv": {
        timezone: tv.timezone,
        today: tv.today,
        fullyBooked: [firstOpenDayFrom(tv.id, addDays(tv.today, 7), tv.taken)],
        lastSlotOnly: firstOpenDayFrom(tv.id, addDays(tv.today, 9), tv.taken),
      },
      "greenstripe-lawn": {
        timezone: lawn.timezone,
        today: lawn.today,
        fullyBooked: [firstOpenDayFrom(lawn.id, addDays(lawn.today, 10), lawn.taken)],
      },
      "brightnest-cleaning": {
        timezone: clean.timezone,
        today: clean.today,
        fullyBooked: [firstOpenDayFrom(clean.id, addDays(clean.today, 14), clean.taken)],
        fragmented: firstOpenDayFrom(clean.id, addDays(clean.today, 16), clean.taken),
      },
    },
  };
}

/** Dates used by the last `npm run seed`, or computed for today if the DB was never seeded. */
export function readSeedTestDates(cwd: string = process.cwd()): SeedTestDates {
  const file = path.join(cwd, SEED_META_PATH);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as SeedTestDates;
  return computeTestDates();
}
