/**
 * Pure booking-hours rules from src/config/businesses.ts (no DB):
 * - open weekdays (EDGE-3: a requested closed day is reported as "closed", not "full");
 * - the longest job that fits one business day (EDGE-2: longer jobs need an on-site estimate);
 * - the minimum booking lead time (EDGE-4).
 */
import { SLOT_MINUTES } from "@/config/constants";
import { minutesOf, weekdayOf } from "@/lib/tz";
import { requireBusiness } from "./business";
import { formatDuration } from "./pricing";

const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

/** Slots (start positions) a business day offers, per weekday: (close - open) / slot. */
function slotsPerDay(businessId: string): number[] {
  const b = requireBusiness(businessId);
  return b.bookingHours.map((h) =>
    Math.max(0, Math.floor((minutesOf(h.close) - minutesOf(h.open)) / SLOT_MINUTES)),
  );
}

/**
 * Longest job (minutes) that fits ONE appointment day: the longest run of consecutive slots
 * any business day offers. 0 for businesses without booking hours.
 */
export function maxBookableMinutes(businessId: string): number {
  return Math.max(0, ...slotsPerDay(businessId)) * SLOT_MINUTES;
}

/** True when the job is too long for one visit and needs an on-site estimate. */
export function requiresOnSiteEstimate(businessId: string, durationMin: number): boolean {
  const max = maxBookableMinutes(businessId);
  return max > 0 && durationMin > max;
}

/** Customer-facing explanation for `requiresOnSiteEstimate`. */
export function onSiteEstimateReason(businessId: string, durationMin: number): string {
  const b = requireBusiness(businessId);
  return (
    `This job is about ${formatDuration(durationMin)} on site — longer than one appointment day ` +
    `(${formatDuration(maxBookableMinutes(businessId))}), so it can't be booked online. ` +
    `${b.shortName} needs to give an on-site estimate and plan a multi-day visit; ` +
    `a person from our team can arrange that.`
  );
}

/** Is `date` (YYYY-MM-DD, business-local) a day the business takes appointments? */
export function isBookingDay(businessId: string, date: string): boolean {
  const b = requireBusiness(businessId);
  const wd = weekdayOf(date);
  return b.bookingHours.some((h) => h.day === wd);
}

/** "We don't take appointments on Sundays." */
export function closedDayMessage(businessId: string, date: string): string {
  const b = requireBusiness(businessId);
  return `${b.shortName} is closed on ${DAY_NAMES[weekdayOf(date)] ?? "that day"}, so ${date} has no appointments.`;
}

/** Earliest bookable start: now + the business's minimum lead time. */
export function earliestStart(businessId: string, now: Date): Date {
  return new Date(now.getTime() + requireBusiness(businessId).minLeadMinutes * 60_000);
}
