/**
 * Appointment availability (SPEC §5 slot model). One Slot = one 60-minute start position for
 * one contractor. A job of N minutes needs ceil(N/60) CONSECUTIVE `open` slots of the SAME
 * contractor; the first is the anchor. Dates are business-local; past starts and anything past
 * the 60-day horizon are never offered.
 */
import type { z } from "zod";
import type { CheckAvailabilityOutput, ServiceConfig, SlotSummary } from "@/contracts";
import { BOOKING_HORIZON_DAYS, SLOT_MINUTES } from "@/config/constants";
import { getServiceDefinition } from "@/config/pricing";
import { addDays, localDateString, zonedTimeToUtc } from "@/lib/tz";
import { requireBusiness } from "./business";
import { checkServiceArea, quoteService } from "./catalog";
import { db, type Tx } from "./db";
import {
  closedDayMessage,
  earliestStart,
  isBookingDay,
  onSiteEstimateReason,
  requiresOnSiteEstimate,
} from "./hours";
import { slotsNeeded } from "./pricing";

/**
 * Grace (minutes) on the lead time at confirm: a time offered while the customer started the
 * form (draft TTL 30 min) is still accepted if it is now slightly inside the lead window.
 */
const CONFIRM_LEAD_GRACE_MIN = 30;

const SLOT_MS = SLOT_MINUTES * 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SlotLike {
  id: string;
  contractorId: string;
  startsAt: Date;
  status: string;
}

export interface Run {
  anchorId: string;
  contractorId: string;
  startsAt: Date;
  slotIds: string[];
}

/**
 * Pure: every run of `needed` consecutive open slots (same contractor, back-to-back start
 * times). Input order does not matter.
 */
export function findRuns(slots: readonly SlotLike[], needed: number): Run[] {
  const byContractor = new Map<string, SlotLike[]>();
  for (const s of slots) {
    const list = byContractor.get(s.contractorId) ?? [];
    list.push(s);
    byContractor.set(s.contractorId, list);
  }
  const runs: Run[] = [];
  for (const [contractorId, list] of byContractor) {
    list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let i = 0; i + needed <= list.length; i++) {
      let ok = true;
      for (let k = 0; k < needed; k++) {
        const s = list[i + k]!;
        if (s.status !== "open") {
          ok = false;
          break;
        }
        if (k > 0 && s.startsAt.getTime() - list[i + k - 1]!.startsAt.getTime() !== SLOT_MS) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const first = list[i]!;
        runs.push({
          anchorId: first.id,
          contractorId,
          startsAt: first.startsAt,
          slotIds: list.slice(i, i + needed).map((s) => s.id),
        });
      }
    }
  }
  return runs.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const timeFmt = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, kind: "time" | "long"): Intl.DateTimeFormat {
  const key = `${tz}|${kind}`;
  let f = timeFmt.get(key);
  if (!f) {
    f =
      kind === "time"
        ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
        : new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          });
    timeFmt.set(key, f);
  }
  return f;
}

/** "9:00 AM" in the business timezone. */
export function localTimeLabel(instant: Date, tz: string): string {
  return fmt(tz, "time").format(instant);
}

/** "Mon, Oct 12, 2026, 9:00 AM MDT". */
export function appointmentLabel(instant: Date, tz: string): string {
  return fmt(tz, "long").format(instant);
}

export function toSlotSummary(
  run: { anchorId: string; startsAt: Date },
  contractor: string,
  tz: string,
  durationMin: number,
): SlotSummary {
  return {
    slotId: run.anchorId,
    startsAt: run.startsAt.toISOString(),
    endsAt: new Date(run.startsAt.getTime() + durationMin * 60_000).toISOString(),
    localDate: localDateString(run.startsAt, tz),
    localTime: localTimeLabel(run.startsAt, tz),
    timezone: tz,
    contractor,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface Horizon {
  tz: string;
  today: string;
  lastDate: string;
  now: Date;
}

export function horizonFor(tz: string, now: Date = new Date()): Horizon {
  const today = localDateString(now, tz);
  return { tz, today, lastDate: addDays(today, BOOKING_HORIZON_DAYS - 1), now };
}

/**
 * All bookable starts (one per start time — the first contractor with a long-enough run)
 * from now + the business's minimum lead time through the horizon end, in time order.
 */
export async function openStarts(
  businessId: string,
  durationMin: number,
  now: Date = new Date(),
): Promise<{ horizon: Horizon; starts: SlotSummary[] }> {
  const b = requireBusiness(businessId);
  const horizon = horizonFor(b.timezone, now);
  const end = zonedTimeToUtc(addDays(horizon.lastDate, 1), "00:00", b.timezone);
  const needed = slotsNeeded(durationMin, SLOT_MINUTES);
  const rows = await db().slot.findMany({
    where: { businessId, startsAt: { gt: earliestStart(businessId, now), lt: end } },
    select: {
      id: true,
      contractorId: true,
      startsAt: true,
      status: true,
      contractor: { select: { name: true, active: true } },
    },
  });
  const active = rows.filter((r) => r.contractor.active);
  const names = new Map(active.map((r) => [r.contractorId, r.contractor.name]));
  const seen = new Set<number>();
  const starts: SlotSummary[] = [];
  for (const run of findRuns(active, needed)) {
    const t = run.startsAt.getTime();
    if (seen.has(t)) continue;
    seen.add(t);
    starts.push(
      toSlotSummary(run, names.get(run.contractorId) ?? "Technician", b.timezone, durationMin),
    );
  }
  return { horizon, starts };
}

export interface AvailabilityQuery {
  serviceCode?: string;
  durationMin?: number;
  /** A full selection: duration is computed by the pricing engine. */
  selection?: z.input<typeof ServiceConfig>;
  date?: string;
  fromDate?: string;
  toDate?: string;
  zip?: string;
  limit?: number;
}

export type AvailabilityResult = z.output<typeof CheckAvailabilityOutput> & {
  durationMin: number;
  slotsNeeded: number;
  horizonEnd: string;
};

/** Job length: selection (priced) > explicit minutes > shortest tier of the service > 60. */
async function resolveDuration(businessId: string, q: AvailabilityQuery): Promise<number> {
  if (q.selection) {
    const r = await quoteService(businessId, q.selection);
    if ("quote" in r) return r.durationMin;
  }
  if (q.durationMin && q.durationMin > 0) return Math.floor(q.durationMin);
  const code = q.serviceCode ?? q.selection?.serviceCode;
  const def = code ? getServiceDefinition(businessId, code) : undefined;
  if (def) return Math.min(...def.tiers.map((t) => t.durationMin));
  return SLOT_MINUTES;
}

export async function checkAvailability(
  businessId: string,
  q: AvailabilityQuery,
  now: Date = new Date(),
): Promise<AvailabilityResult> {
  const b = requireBusiness(businessId);
  const limit = Math.min(Math.max(q.limit ?? 6, 1), 20);
  const empty = (message: string, durationMin = 0, horizonEnd = ""): AvailabilityResult => ({
    timezone: b.timezone,
    requestedDate: q.date,
    fullyBooked: false,
    slots: [],
    nextAvailable: [],
    message,
    durationMin,
    slotsNeeded: slotsNeeded(Math.max(durationMin, 1)),
    horizonEnd,
  });

  if (b.kind !== "service") return empty(`${b.name} sells products; there are no appointments.`);
  const code = q.serviceCode ?? q.selection?.serviceCode;
  if (code && !getServiceDefinition(businessId, code)) {
    return empty(`No service "${code}" here.`);
  }
  if (q.zip) {
    const area = await checkServiceArea(businessId, q.zip);
    if (!area.served) return empty(area.message);
  }
  for (const d of [q.date, q.fromDate, q.toDate]) {
    if (d !== undefined && !DATE_RE.test(d)) return empty(`Dates must look like YYYY-MM-DD.`);
  }

  const durationMin = await resolveDuration(businessId, q);
  const { horizon, starts } = await openStarts(businessId, durationMin, now);
  const base = {
    timezone: b.timezone,
    durationMin,
    slotsNeeded: slotsNeeded(durationMin),
    horizonEnd: horizon.lastDate,
  };

  // EDGE-2: never present an empty calendar for a job that cannot fit one business day.
  if (requiresOnSiteEstimate(businessId, durationMin)) {
    return {
      ...base,
      requestedDate: q.date,
      fullyBooked: false,
      requiresOnSiteEstimate: true,
      slots: [],
      nextAvailable: [],
      message: onSiteEstimateReason(businessId, durationMin),
    };
  }

  if (q.date) {
    const date = q.date;
    // EDGE-3: a closed day is "closed", not "fully booked".
    if (date >= horizon.today && date <= horizon.lastDate && !isBookingDay(businessId, date)) {
      const next = starts.filter((s) => s.localDate > date).slice(0, 5);
      return {
        ...base,
        requestedDate: date,
        fullyBooked: false,
        closed: true,
        slots: [],
        nextAvailable: next,
        message:
          closedDayMessage(businessId, date) +
          (next.length > 0 ? " The nearest openings are listed in nextAvailable." : ""),
      };
    }
    if (date < horizon.today || date > horizon.lastDate) {
      const near =
        date < horizon.today ? starts.slice(0, 5) : starts.slice(Math.max(0, starts.length - 5));
      return {
        ...base,
        requestedDate: date,
        fullyBooked: false,
        slots: [],
        nextAvailable: near,
        message:
          date < horizon.today
            ? `${date} has already passed (today is ${horizon.today} in ${b.timezone}).`
            : `We book up to ${BOOKING_HORIZON_DAYS} days ahead (through ${horizon.lastDate}).`,
      };
    }
    const onDate = starts.filter((s) => s.localDate === date);
    if (onDate.length > 0) {
      return {
        ...base,
        requestedDate: date,
        fullyBooked: false,
        slots: onDate.slice(0, limit),
        nextAvailable: [],
      };
    }
    let next = starts.filter((s) => s.localDate > date).slice(0, 5);
    if (next.length === 0) next = starts.filter((s) => s.localDate < date).slice(-5);
    return {
      ...base,
      requestedDate: date,
      fullyBooked: true,
      slots: [],
      nextAvailable: next,
      message:
        `${date} has no opening long enough for a ${durationMin}-minute job.` +
        (next.length > 0
          ? ` The nearest openings are listed in nextAvailable.`
          : ` No openings in the next ${BOOKING_HORIZON_DAYS} days.`),
    };
  }

  const from = q.fromDate && q.fromDate > horizon.today ? q.fromDate : horizon.today;
  const to = q.toDate && q.toDate < horizon.lastDate ? q.toDate : horizon.lastDate;
  const inRange = starts.filter((s) => s.localDate >= from && s.localDate <= to);
  if (inRange.length > 0) {
    return { ...base, fullyBooked: false, slots: inRange.slice(0, limit), nextAvailable: [] };
  }
  const next = starts.filter((s) => s.localDate > to).slice(0, 5);
  return {
    ...base,
    fullyBooked: false,
    slots: [],
    nextAvailable: next,
    message: `No openings between ${from} and ${to}.`,
  };
}

// ---------------------------------------------------------------------------
// Claiming (used inside the confirm transaction)
// ---------------------------------------------------------------------------

/**
 * Find the run to book for `anchorSlotId`: that contractor's consecutive slots if all open,
 * otherwise another active contractor with a full open run at the same start time.
 * Read-only; the caller flips them with a guarded update. Returns null if none fits.
 */
export async function findRunForAnchor(
  tx: Tx,
  businessId: string,
  anchorSlotId: string,
  durationMin: number,
  now: Date = new Date(),
): Promise<(Run & { contractorName: string }) | null> {
  const anchor = await tx.slot.findFirst({ where: { id: anchorSlotId, businessId } });
  // Lead time (EDGE-4), with a short grace for a form that was opened a few minutes ago.
  const earliest = earliestStart(
    businessId,
    new Date(now.getTime() - CONFIRM_LEAD_GRACE_MIN * 60_000),
  );
  if (!anchor || anchor.startsAt.getTime() <= Math.max(now.getTime(), earliest.getTime())) {
    return null;
  }
  const b = requireBusiness(businessId);
  const horizonEnd = zonedTimeToUtc(
    addDays(horizonFor(b.timezone, now).lastDate, 1),
    "00:00",
    b.timezone,
  );
  if (anchor.startsAt.getTime() >= horizonEnd.getTime()) return null;

  const needed = slotsNeeded(durationMin, SLOT_MINUTES);
  const end = new Date(anchor.startsAt.getTime() + needed * SLOT_MS);
  const rows = await tx.slot.findMany({
    where: { businessId, startsAt: { gte: anchor.startsAt, lt: end } },
    include: { contractor: { select: { name: true, active: true } } },
  });
  const candidates = findRuns(
    rows.filter((r) => r.contractor.active),
    needed,
  ).filter((r) => r.startsAt.getTime() === anchor.startsAt.getTime());
  const preferred =
    candidates.find((r) => r.contractorId === anchor.contractorId) ?? candidates[0] ?? null;
  if (!preferred) return null;
  const name = rows.find((r) => r.contractorId === preferred.contractorId)?.contractor.name;
  return { ...preferred, contractorName: name ?? "Technician" };
}

/** Is `anchorSlotId` still bookable for this duration (read-only, outside a transaction)? */
export async function isAnchorBookable(
  businessId: string,
  anchorSlotId: string,
  durationMin: number,
  now: Date = new Date(),
): Promise<(Run & { contractorName: string }) | null> {
  return findRunForAnchor(db() as unknown as Tx, businessId, anchorSlotId, durationMin, now);
}
