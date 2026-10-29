/**
 * Dependency-free IANA timezone helpers (Intl-based). Used by the seed for slot generation
 * and available to domain/availability. All Date objects are UTC instants.
 */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    dtf(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date `YYYY-MM-DD` of an instant in a timezone. */
export function localDateString(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Add whole days to a `YYYY-MM-DD` string (calendar arithmetic, timezone-free). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a `YYYY-MM-DD` calendar date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Offset (ms) of `timeZone` from UTC at `instant`: local = utc + offset. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a local wall-clock time (`YYYY-MM-DD`, `HH:MM`) in `timeZone` to a UTC instant.
 * For DST gaps the result is shifted forward; for overlaps the earlier instant is used.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two-pass offset correction (the offset at the guess may differ from the offset at the result).
  let utc = guess - offsetMs(new Date(guess), timeZone);
  const corrected = guess - offsetMs(new Date(utc), timeZone);
  if (corrected !== utc) utc = corrected;
  return new Date(utc);
}

/** "HH:MM" → minutes after midnight. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** Minutes after midnight → "HH:MM". */
export function timeOf(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
